from fastapi import FastAPI, UploadFile, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from contextlib import asynccontextmanager
from pathlib import Path
from datetime import datetime
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
from routers.enrollment import router as enrollment_router, load_kids
from routers.settings import router as settings_router
from routers.dashboard import router as dashboard_router

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


def _enrich_matches(result: dict, kid_names: dict) -> tuple[list, float]:
    """Add kid_name to each match. Return (matched_kids, best_confidence)."""
    for m in result.get("matches", []):
        m["kid_name"] = kid_names.get(m["kid_id"], m["kid_id"])
    matched_kids = [m for m in result.get("matches", []) if m["matched"]]
    best_conf = max((m["confidence"] for m in result.get("matches", [])), default=0.0)
    return matched_kids, best_conf


async def _forward_photo(forward_to: str, img_bytes: bytes, matched_kids: list,
                         best_conf: float, caption_suffix: str = "") -> tuple[bool, str | None]:
    """Send matched photo to bot /send. Return (forwarded, error_msg)."""
    try:
        names = " & ".join(m["kid_name"] for m in matched_kids)
        verb = "are" if len(matched_kids) > 1 else "is"
        caption = f"{names} {verb} in this photo! ({(best_conf * 100):.0f}% confidence){caption_suffix}"
        async with httpx.AsyncClient(timeout=15.0) as hx:
            await hx.post(f"{BOT_API_URL}/send", json={
                "to": forward_to,
                "caption": caption,
                "image_b64": base64.b64encode(img_bytes).decode(),
            })
        return True, None
    except Exception as e:
        return False, str(e)


async def save_to_google_photos(img_bytes: bytes, group_name: str, matched_kids: list, settings: dict):
    """Upload matched photo to Google Photos if configured."""
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
    organize_by = settings.get("google_photos_album_organize_by", "group")
    if organize_by == "kid":
        for m in matched_kids:
            await svc.upload_photo(img_bytes, album_name=m["kid_name"], filename=f"{timestamp}.jpg")
    else:
        album = settings.get("google_photos_album_name", "").strip() or group_name
        await svc.upload_photo(img_bytes, album_name=album, filename=f"{timestamp}.jpg")


def save_matched_photo(img_bytes: bytes, group_name: str, kid_names: list, settings: dict):
    """Save a matched photo to the configured local folder."""
    if settings.get("save_photos_enabled") != "true":
        return
    save_path = settings.get("save_photos_path", "").strip()
    if not save_path:
        return
    base = Path(save_path)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:19]
    try:
        if settings.get("save_photos_organize_by") == "kid":
            for name in kid_names:
                folder = base / _safe_filename(name)
                folder.mkdir(parents=True, exist_ok=True)
                (folder / f"{timestamp}.jpg").write_bytes(img_bytes)
        else:
            folder = base / _safe_filename(group_name)
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f"{timestamp}.jpg").write_bytes(img_bytes)
    except Exception:
        pass


# ── App setup ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    for subdir in ["enrolled", "embeddings", "temp"]:
        (DATA_DIR / subdir).mkdir(parents=True, exist_ok=True)
    app.state.face_service = FaceService(str(DATA_DIR))
    yield


app = FastAPI(title="Parent Tool", lifespan=lifespan)

app.include_router(enrollment_router, prefix="/api/enrollment")
app.include_router(settings_router, prefix="/api/settings")
app.include_router(dashboard_router, prefix="/api/dashboard")

app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")


@app.get("/")
async def root():
    return RedirectResponse(url="/static/index.html")


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.post("/api/analyze")
async def analyze_photo(request: Request, file: UploadFile,
                        group_id: str = "", group_name: str = "", sender: str = "unknown",
                        forward: bool = False, is_test: bool = False):
    """Called by the WhatsApp bot (or test panel) when a photo arrives."""
    temp_path = DATA_DIR / "temp" / f"{uuid.uuid4()}.jpg"
    try:
        async with aiofiles.open(temp_path, "wb") as f:
            await f.write(await file.read())

        db_settings = get_settings()
        threshold = float(db_settings.get("confidence_threshold", "0.35"))
        kid_ids, kid_names, config_name = _resolve_group(group_id, db_settings)
        group_name = group_name or config_name

        if not kid_ids:
            return {"matched": False, "faces_detected": 0, "matches": [],
                    "error": "No kids configured for this group"}

        result = request.app.state.face_service.analyze_photo(str(temp_path), kid_ids, threshold)
        matched_kids, best_confidence = _enrich_matches(result, kid_names)

        if result.get("matched"):
            img_bytes = temp_path.read_bytes()
            save_matched_photo(img_bytes, group_name, [m["kid_name"] for m in matched_kids], db_settings)
            await save_to_google_photos(img_bytes, group_name, matched_kids, db_settings)

        forwarded = False
        if forward and result.get("matched"):
            forward_to = db_settings.get("forward_to_id")
            if forward_to:
                forwarded, fwd_err = await _forward_photo(
                    forward_to, img_bytes, matched_kids, best_confidence, " [test]"
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
    """Fetch historical image messages from a WhatsApp group and scan them for kids."""
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
            r = await hx.get(f"{BOT_API_URL}/history-images",
                             params={"groupId": group_id, "since": since_ts})
            data = r.json()
            images = data.get("images", [])
            note = data.get("note")
    except Exception as e:
        return {"error": f"Could not reach bot: {e}", "results": [], "total": 0, "matched": 0}

    if not images:
        return {"group_name": group_name, "total": 0, "matched": 0, "results": [],
                "note": note or "No image messages found in that time range"}

    results = []
    matched_count = 0

    # Single client for all image downloads
    async with httpx.AsyncClient(timeout=30.0) as hx:
        for img_info in images:
            msg_id = img_info["id"]
            sender = img_info.get("sender", "unknown")
            timestamp = img_info.get("timestamp", 0)

            try:
                r = await hx.get(f"{BOT_API_URL}/download-image/{msg_id}",
                                 params={"groupId": group_id})
                if r.status_code != 200:
                    results.append({"msg_id": msg_id, "sender": sender, "timestamp": timestamp,
                                    "error": f"Download failed ({r.status_code})"})
                    continue
                img_bytes = base64.b64decode(r.json()["image_b64"])
            except Exception as e:
                results.append({"msg_id": msg_id, "sender": sender, "timestamp": timestamp,
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
                        forward_to, img_bytes, matched_kids, best_conf,
                        f" [from {group_name} history]"
                    )

                results.append({
                    "msg_id": msg_id,
                    "sender": sender,
                    "timestamp": timestamp,
                    "faces_detected": result.get("faces_detected", 0),
                    "matched": result.get("matched", False),
                    "confidence": best_conf,
                    "forwarded": forwarded,
                    "kids": [m["kid_name"] for m in matched_kids],
                })
            finally:
                temp_path.unlink(missing_ok=True)

    return {"group_name": group_name, "total": len(images), "matched": matched_count, "results": results}
