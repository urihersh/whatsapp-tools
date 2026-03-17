from fastapi import FastAPI, UploadFile, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from contextlib import asynccontextmanager
from pathlib import Path
from datetime import datetime
import asyncio
import os
import json
import time
import uuid
import base64
import httpx
import aiofiles
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent.parent / ".env")

from database import init_db, get_settings, log_activity, save_setting
from face_service import FaceService
from google_photos import GooglePhotosService
from ai_service import get_moment_caption, summarize_messages
from routers.enrollment import router as enrollment_router, load_kids
from routers.settings import router as settings_router
from routers.dashboard import router as dashboard_router
from routers.auth import router as auth_router

# ── Digest queue ───────────────────────────────────────────────────────────────
_digest_queue: list[dict] = []  # items buffered when digest_mode is on

DATA_DIR = Path(os.getenv("DATA_DIR", "./data")).resolve()
BOT_API_URL = os.getenv("BOT_API_URL", "http://localhost:3001")


# ── Helpers ────────────────────────────────────────────────────────────────────

def _safe_filename(name: str) -> str:
    return "".join(c if c.isalnum() or c in " -_." else "_" for c in name).strip() or "unknown"


def _resolve_group(group_id: str, db_settings: dict) -> tuple[list, dict, str]:
    """Return (kid_ids, kid_names, group_name) from watch_groups config."""
    kid_ids, kid_names, group_name = [], {}, group_id
    try:
        watch_groups = json.loads(db_settings.get("watch_groups", "[]"))
        for g in watch_groups:
            if g.get("id") == group_id:
                kid_ids = g.get("kid_ids", [])
                group_name = g.get("name", group_id)
                break
        kid_names = {k["id"]: k["name"] for k in load_kids()}
    except Exception:
        pass
    return kid_ids, kid_names, group_name


def _resolve_kids(kid_ids: str, group_id: str, group_name: str, db_settings: dict) -> tuple[list, dict, str]:
    """Return (kid_id_list, kid_names, resolved_name).

    If kid_ids is provided without a group_id, parses the comma-separated IDs directly.
    Otherwise resolves from the watch_groups config.
    """
    if kid_ids and not group_id:
        kid_id_list = [k.strip() for k in kid_ids.split(",") if k.strip()]
        kid_names = {k["id"]: k["name"] for k in load_kids()}
        return kid_id_list, kid_names, group_name or "manual scan"
    kid_id_list, kid_names, config_name = _resolve_group(group_id, db_settings)
    return kid_id_list, kid_names, group_name or config_name


def _enrich_matches(result: dict, kid_names: dict) -> tuple[list, float]:
    """Add kid_name to each match. Return (matched_kids, best_confidence)."""
    for m in result.get("matches", []):
        m["kid_name"] = kid_names.get(m["kid_id"], m["kid_id"])
    matched_kids = [m for m in result.get("matches", []) if m["matched"]]
    best_conf = max((m["confidence"] for m in result.get("matches", [])), default=0.0)
    return matched_kids, best_conf


async def _forward_media(forward_to: str, media_bytes: bytes, matched_kids: list,
                         best_conf: float, is_video: bool = False,
                         caption_suffix: str = "") -> tuple[bool, str | None]:
    """Send matched photo or video to the bot. Return (forwarded, error_msg)."""
    try:
        names = " & ".join(m["kid_name"] for m in matched_kids)
        verb = "are" if len(matched_kids) > 1 else "is"
        media_type = "video" if is_video else "photo"
        caption = f"{names} {verb} in this {media_type}! ({(best_conf * 100):.0f}% confidence){caption_suffix}"
        endpoint = "send-video" if is_video else "send"
        payload_key = "video_b64" if is_video else "image_b64"
        timeout = 60.0 if is_video else 15.0
        async with httpx.AsyncClient(timeout=timeout) as hx:
            await hx.post(f"{BOT_API_URL}/{endpoint}", json={
                "to": forward_to,
                "caption": caption,
                payload_key: base64.b64encode(media_bytes).decode(),
            })
        return True, None
    except Exception as e:
        return False, str(e)


async def save_to_google_photos(media_bytes: bytes, group_name: str, matched_kids: list, settings: dict,
                               filename: str = ""):
    """Upload matched photo or video to Google Photos if configured."""
    if settings.get("google_photos_enabled") != "true":
        return
    client_id = settings.get("google_photos_client_id", "").strip()
    client_secret = settings.get("google_photos_client_secret", "").strip()
    tokens_json = settings.get("google_photos_tokens", "")
    if not (client_id and client_secret and tokens_json):
        return
    try:
        tokens = json.loads(tokens_json)
    except Exception:
        return

    svc = GooglePhotosService(
        client_id, client_secret,
        redirect_uri=f"{os.getenv('BACKEND_PUBLIC_URL', 'http://localhost:8000')}/api/settings/google-photos/callback",
        tokens=tokens,
        on_tokens_updated=lambda t: save_setting("google_photos_tokens", json.dumps(t)),
    )
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    upload_filename = filename or f"{timestamp}.jpg"
    organize_by = settings.get("google_photos_album_organize_by", "group")
    if organize_by == "kid":
        await asyncio.gather(*[
            svc.upload_photo(media_bytes, album_name=m["kid_name"], filename=upload_filename)
            for m in matched_kids
        ])
    else:
        album = settings.get("google_photos_album_name", "").strip() or group_name
        await svc.upload_photo(media_bytes, album_name=album, filename=upload_filename)


def save_matched_photo(img_bytes: bytes, group_name: str, kid_names: list, settings: dict,
                       original_filename: str = "") -> str:
    """Save a matched photo to the configured local folder. Returns saved path or ''."""
    if settings.get("save_photos_enabled") != "true":
        return ""
    save_path = settings.get("save_photos_path", "").strip()
    if not save_path:
        return ""
    base = Path(save_path)
    if original_filename:
        filename = _safe_filename(original_filename)
    else:
        filename = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:19] + ".jpg"
    try:
        if settings.get("save_photos_organize_by") == "kid":
            first_path = ""
            for name in kid_names:
                folder = base / _safe_filename(name)
                folder.mkdir(parents=True, exist_ok=True)
                dest = folder / filename
                dest.write_bytes(img_bytes)
                if not first_path:
                    first_path = str(dest)
            return first_path
        else:
            folder = base / _safe_filename(group_name)
            folder.mkdir(parents=True, exist_ok=True)
            dest = folder / filename
            dest.write_bytes(img_bytes)
            return str(dest)
    except Exception:
        return ""


# ── App setup ──────────────────────────────────────────────────────────────────

async def _digest_scheduler():
    """Background task: send buffered digest at the configured daily time."""
    last_sent_date = None
    while True:
        await asyncio.sleep(60)
        try:
            settings = get_settings()
            if settings.get("digest_mode") != "true" or not _digest_queue:
                continue
            digest_time = settings.get("digest_time", "20:00")
            now = datetime.now()
            if last_sent_date == now.date():
                continue
            h, m = map(int, digest_time.split(":"))
            if now.hour == h and now.minute == m:
                await _flush_digest(settings)
                last_sent_date = now.date()
        except Exception:
            pass


async def _flush_digest(settings: dict):
    """Send all queued matches as a digest message and clear the queue."""
    global _digest_queue
    if not _digest_queue:
        return
    forward_to = settings.get("forward_to_id")
    if not forward_to:
        return
    items = list(_digest_queue)
    _digest_queue.clear()

    count = len(items)
    lines = "\n".join(
        f"• {', '.join(it['kid_names'])} in {it['group_name']} ({int(it['confidence'] * 100)}%)"
        for it in items
    )
    summary_text = f"📸 Daily digest: {count} match{'es' if count != 1 else ''} today\n{lines}"
    try:
        async with httpx.AsyncClient(timeout=15.0) as hx:
            await hx.post(f"{BOT_API_URL}/send-text", json={"to": forward_to, "text": summary_text})
        for it in items:
            endpoint = "send-video" if it["is_video"] else "send"
            key = "video_b64" if it["is_video"] else "image_b64"
            caption = f"{', '.join(it['kid_names'])} — {it['group_name']}"
            async with httpx.AsyncClient(timeout=60.0) as hx:
                await hx.post(f"{BOT_API_URL}/{endpoint}", json={
                    "to": forward_to,
                    "caption": caption,
                    key: base64.b64encode(it["media_bytes"]).decode(),
                })
    except Exception:
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    for subdir in ["enrolled", "embeddings", "temp"]:
        (DATA_DIR / subdir).mkdir(parents=True, exist_ok=True)
    app.state.face_service = FaceService(str(DATA_DIR))
    task = asyncio.create_task(_digest_scheduler())
    yield
    task.cancel()


app = FastAPI(title="Parent Tool", lifespan=lifespan)

app.include_router(enrollment_router, prefix="/api/enrollment")
app.include_router(settings_router, prefix="/api/settings")
app.include_router(dashboard_router, prefix="/api/dashboard")
app.include_router(auth_router, prefix="/api/auth")

app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")


@app.get("/")
async def root():
    return RedirectResponse(url="/static/index.html")


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.post("/api/analyze")
async def analyze_photo(request: Request, file: UploadFile,
                        group_id: str = "", group_name: str = "", sender: str = "unknown",
                        kid_ids: str = "", forward: bool = False, is_test: bool = False):
    """Called by the WhatsApp bot (or test panel) when a photo arrives.

    kid_ids: optional comma-separated kid IDs; when provided without a group_id,
             bypasses group resolution so callers can scan for specific kids directly.
    """
    file_bytes = await file.read()
    temp_path = DATA_DIR / "temp" / f"{uuid.uuid4()}.jpg"
    try:
        async with aiofiles.open(temp_path, "wb") as f:
            await f.write(file_bytes)

        db_settings = get_settings()
        threshold = float(db_settings.get("confidence_threshold", "0.35"))
        kid_id_list, kid_names, group_name = _resolve_kids(kid_ids, group_id, group_name, db_settings)

        if not kid_id_list:
            return {"matched": False, "faces_detected": 0, "matches": [],
                    "error": "No kids configured for this group"}

        result = request.app.state.face_service.analyze_photo(str(temp_path), kid_id_list, threshold)
        matched_kids, best_confidence = _enrich_matches(result, kid_names)

        matched_photo_path = ""
        if result.get("matched"):
            matched_photo_path = save_matched_photo(
                file_bytes, group_name, [m["kid_name"] for m in matched_kids], db_settings,
                original_filename=file.filename or ""
            )
            await save_to_google_photos(file_bytes, group_name, matched_kids, db_settings)

        forwarded = False
        if result.get("matched"):
            forward_to = db_settings.get("forward_to_id")
            kid_name_list = [m["kid_name"] for m in matched_kids]
            if db_settings.get("digest_mode") == "true":
                _digest_queue.append({
                    "kid_names": kid_name_list,
                    "group_name": group_name or group_id or "unknown",
                    "confidence": best_confidence,
                    "is_video": False,
                    "media_bytes": file_bytes,
                })
            elif forward and forward_to:
                caption_suffix = " [test]" if is_test else ""
                if db_settings.get("ai_captions_enabled") == "true":
                    caption_text = await asyncio.get_event_loop().run_in_executor(
                        None, get_moment_caption, file_bytes, kid_name_list
                    )
                    if caption_text:
                        caption_suffix = f"\n💬 {caption_text}" + caption_suffix
                forwarded, fwd_err = await _forward_media(
                    forward_to, file_bytes, matched_kids, best_confidence, caption_suffix=caption_suffix
                )
                if fwd_err:
                    result["forward_error"] = fwd_err

        result["forwarded"] = forwarded
        if not is_test:
            log_activity(
                photo_filename=file.filename or "photo.jpg",
                sender=sender or "unknown",
                group_name=group_name or group_id or "unknown",
                faces_detected=result.get("faces_detected", 0),
                matched=result.get("matched", False),
                confidence=best_confidence,
                forwarded=forwarded,
                kid_names=", ".join(m["kid_name"] for m in matched_kids),
                matched_photo_path=matched_photo_path,
            )

        return result
    finally:
        temp_path.unlink(missing_ok=True)


@app.post("/api/analyze-video")
async def analyze_video(request: Request, file: UploadFile,
                        group_id: str = "", group_name: str = "", sender: str = "unknown",
                        kid_ids: str = "", forward: bool = False, is_test: bool = False):
    """Called by the WhatsApp bot when a video arrives, or by the upload scan panel."""
    file_bytes = await file.read()
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    temp_path = DATA_DIR / "temp" / f"{uuid.uuid4()}{suffix}"
    try:
        async with aiofiles.open(temp_path, "wb") as f:
            await f.write(file_bytes)

        db_settings = get_settings()
        threshold = float(db_settings.get("confidence_threshold", "0.35"))
        kid_id_list, kid_names, group_name = _resolve_kids(kid_ids, group_id, group_name, db_settings)

        if not kid_id_list:
            return {"matched": False, "faces_detected": 0, "matches": [],
                    "error": "No kids configured for this group"}

        result = request.app.state.face_service.analyze_video(str(temp_path), kid_id_list, threshold)
        result.pop("best_frame_bytes", None)  # no longer forwarded as image
        matched_kids, best_confidence = _enrich_matches(result, kid_names)

        matched_photo_path = ""
        forwarded = False
        if result.get("matched"):
            video_filename = file.filename or "video.mp4"
            matched_photo_path = save_matched_photo(
                file_bytes, group_name, [m["kid_name"] for m in matched_kids], db_settings,
                original_filename=video_filename
            )
            await save_to_google_photos(file_bytes, group_name, matched_kids, db_settings,
                                        filename=video_filename)
            forward_to = db_settings.get("forward_to_id")
            kid_name_list = [m["kid_name"] for m in matched_kids]
            if db_settings.get("digest_mode") == "true":
                _digest_queue.append({
                    "kid_names": kid_name_list,
                    "group_name": group_name or group_id or "unknown",
                    "confidence": best_confidence,
                    "is_video": True,
                    "media_bytes": file_bytes,
                })
            elif forward and forward_to:
                forwarded, fwd_err = await _forward_media(
                    forward_to, file_bytes, matched_kids, best_confidence, is_video=True
                )
                if fwd_err:
                    result["forward_error"] = fwd_err

        result["forwarded"] = forwarded
        if not is_test:
            log_activity(
                photo_filename=file.filename or "video.mp4",
                sender=sender or "unknown",
                group_name=group_name or group_id or "unknown",
                faces_detected=result.get("faces_detected", 0),
                matched=result.get("matched", False),
                confidence=best_confidence,
                forwarded=forwarded,
                kid_names=", ".join(m["kid_name"] for m in matched_kids),
                matched_photo_path=matched_photo_path,
            )
        return result
    finally:
        temp_path.unlink(missing_ok=True)


@app.post("/api/fetch-history")
async def fetch_history(group_id: str = ""):
    """Ask the bot to request older message history from WhatsApp for a group."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as hx:
            r = await hx.post(f"{BOT_API_URL}/fetch-history", json={"groupId": group_id})
            return r.json()
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/scan-history")
async def scan_history(request: Request, group_id: str = "", days_back: int = 7,
                       since_date: str = "", forward_matches: bool = False):
    """Fetch historical image and video messages from a WhatsApp group and scan them for kids."""
    db_settings = get_settings()
    threshold = float(db_settings.get("confidence_threshold", "0.35"))
    forward_to = db_settings.get("forward_to_id")
    kid_ids, kid_names, group_name = _resolve_group(group_id, db_settings)

    if not kid_ids:
        return {"error": "No kids configured for this group", "results": [], "total": 0, "matched": 0}

    if since_date:
        since_ts = int(datetime.strptime(since_date, "%Y-%m-%d").timestamp() * 1000)
    elif days_back == 0:
        since_ts = 0
    else:
        since_ts = int((time.time() - days_back * 86400) * 1000)

    try:
        async with httpx.AsyncClient(timeout=15.0) as hx:
            img_r, vid_r = await asyncio.gather(
                hx.get(f"{BOT_API_URL}/history-images", params={"groupId": group_id, "since": since_ts}),
                hx.get(f"{BOT_API_URL}/history-videos", params={"groupId": group_id, "since": since_ts}),
            )
            images = img_r.json().get("images", [])
            videos = vid_r.json().get("videos", [])
            note = img_r.json().get("note")
    except Exception as e:
        return {"error": f"Could not reach bot: {e}", "results": [], "total": 0, "matched": 0}

    if not images and not videos:
        return {"group_name": group_name, "total": 0, "matched": 0, "results": [],
                "note": note or "No photos or videos found in that time range"}

    results = []
    matched_count = 0

    async with httpx.AsyncClient(timeout=90.0) as hx:
        # ── Images ────────────────────────────────────────────────────────────
        for img_info in images:
            msg_id = img_info["id"]
            sender = img_info.get("sender", "unknown")
            timestamp = img_info.get("timestamp", 0)
            try:
                r = await hx.get(f"{BOT_API_URL}/download-image/{msg_id}", params={"groupId": group_id})
                if r.status_code != 200:
                    results.append({"msg_id": msg_id, "sender": sender, "timestamp": timestamp, "type": "image",
                                    "error": f"Download failed ({r.status_code})"})
                    continue
                img_bytes = base64.b64decode(r.json()["image_b64"])
            except Exception as e:
                results.append({"msg_id": msg_id, "sender": sender, "timestamp": timestamp, "type": "image",
                                "error": str(e)})
                continue

            temp_path = DATA_DIR / "temp" / f"{uuid.uuid4()}.jpg"
            try:
                temp_path.write_bytes(img_bytes)
                result = request.app.state.face_service.analyze_photo(str(temp_path), kid_ids, threshold)
                matched_kids, best_conf = _enrich_matches(result, kid_names)
                if result.get("matched"):
                    save_matched_photo(img_bytes, group_name, [m["kid_name"] for m in matched_kids], db_settings)
                    await save_to_google_photos(img_bytes, group_name, matched_kids, db_settings)
                    matched_count += 1
                forwarded = False
                if forward_matches and result.get("matched") and forward_to:
                    forwarded, _ = await _forward_photo(
                        forward_to, img_bytes, matched_kids, best_conf, f" [from {group_name} history]"
                    )
                results.append({
                    "msg_id": msg_id, "sender": sender, "timestamp": timestamp, "type": "image",
                    "faces_detected": result.get("faces_detected", 0),
                    "matched": result.get("matched", False),
                    "confidence": best_conf, "forwarded": forwarded,
                    "kids": [m["kid_name"] for m in matched_kids],
                })
            finally:
                temp_path.unlink(missing_ok=True)

        # ── Videos ────────────────────────────────────────────────────────────
        for vid_info in videos:
            msg_id = vid_info["id"]
            sender = vid_info.get("sender", "unknown")
            timestamp = vid_info.get("timestamp", 0)
            try:
                r = await hx.get(f"{BOT_API_URL}/download-video/{msg_id}", params={"groupId": group_id})
                if r.status_code != 200:
                    results.append({"msg_id": msg_id, "sender": sender, "timestamp": timestamp, "type": "video",
                                    "error": f"Download failed ({r.status_code})"})
                    continue
                vid_bytes = base64.b64decode(r.json()["video_b64"])
            except Exception as e:
                results.append({"msg_id": msg_id, "sender": sender, "timestamp": timestamp, "type": "video",
                                "error": str(e)})
                continue

            temp_path = DATA_DIR / "temp" / f"{uuid.uuid4()}.mp4"
            try:
                temp_path.write_bytes(vid_bytes)
                result = request.app.state.face_service.analyze_video(str(temp_path), kid_ids, threshold)
                result.pop("best_frame_bytes", None)
                matched_kids, best_conf = _enrich_matches(result, kid_names)
                if result.get("matched"):
                    save_matched_photo(vid_bytes, group_name, [m["kid_name"] for m in matched_kids], db_settings,
                                       original_filename=f"{msg_id}.mp4")
                    await save_to_google_photos(vid_bytes, group_name, matched_kids, db_settings,
                                                filename=f"{msg_id}.mp4")
                    matched_count += 1
                forwarded = False
                if forward_matches and result.get("matched") and forward_to:
                    forwarded, _ = await _forward_media(
                        forward_to, vid_bytes, matched_kids, best_conf,
                        is_video=True, caption_suffix=f" [from {group_name} history]"
                    )
                results.append({
                    "msg_id": msg_id, "sender": sender, "timestamp": timestamp, "type": "video",
                    "faces_detected": result.get("faces_detected", 0),
                    "matched": result.get("matched", False),
                    "confidence": best_conf, "forwarded": forwarded,
                    "kids": [m["kid_name"] for m in matched_kids],
                    "frames_sampled": result.get("frames_sampled", 0),
                })
            finally:
                temp_path.unlink(missing_ok=True)

    results.sort(key=lambda r: r.get("timestamp", 0))
    return {"group_name": group_name, "total": len(images) + len(videos),
            "total_images": len(images), "total_videos": len(videos),
            "matched": matched_count, "results": results}


# ── Summarize group ─────────────────────────────────────────────────────────────

@app.post("/api/summarize-group")
async def summarize_group(group_id: str = "", limit: int = 100):
    """Fetch recent text messages from a group and summarize with Claude."""
    db_settings = get_settings()
    _, _, group_name = _resolve_group(group_id, db_settings)
    try:
        async with httpx.AsyncClient(timeout=10.0) as hx:
            r = await hx.get(f"{BOT_API_URL}/history-text", params={"groupId": group_id})
            messages = r.json().get("messages", [])
    except Exception as e:
        return {"error": f"Could not reach bot: {e}"}

    if not messages:
        return {"summary": "", "message_count": 0, "group_name": group_name,
                "note": "No text messages stored for this group yet"}

    recent = messages[-limit:]
    transcript = "\n".join(f"{m['sender']}: {m['text']}" for m in recent)
    summary = await asyncio.get_event_loop().run_in_executor(
        None, summarize_messages, transcript, group_name
    )
    return {"summary": summary, "message_count": len(recent), "group_name": group_name}


# ── Digest endpoints ─────────────────────────────────────────────────────────────

@app.get("/api/digest/queue")
async def digest_queue_status():
    return {
        "count": len(_digest_queue),
        "items": [
            {"kid_names": it["kid_names"], "group_name": it["group_name"],
             "confidence": it["confidence"], "is_video": it["is_video"]}
            for it in _digest_queue
        ],
    }


@app.post("/api/digest/send-now")
async def digest_send_now():
    """Flush the digest queue immediately."""
    if not _digest_queue:
        return {"ok": True, "sent": 0}
    settings = get_settings()
    count = len(_digest_queue)
    await _flush_digest(settings)
    return {"ok": True, "sent": count}
