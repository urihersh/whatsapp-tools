import io
import json
import os
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, UploadFile, File
from fastapi.responses import StreamingResponse, JSONResponse
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent.parent.parent / ".env")

from database import get_settings, save_setting

DATA_DIR = Path(os.getenv("DATA_DIR", "./data")).resolve()

# Settings keys to include in backup — excludes secrets and platform credentials
SCOUT_KEYS = [
    "watch_groups",
    "confidence_threshold",
    "forward_to_id",
    "forward_to_name",
    "save_photos_enabled",
    "save_photos_path",
    "save_photos_organize_by",
    "google_photos_enabled",
    "google_photos_album_organize_by",
    "google_photos_album_name",
    "digest_mode",
    "digest_time",
]

router = APIRouter(tags=["backup"])


@router.get("/backup")
async def export_backup():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # Scout settings
        settings = get_settings()
        scout_settings = {k: settings[k] for k in SCOUT_KEYS if k in settings and settings[k] is not None}
        zf.writestr("scout_settings.json", json.dumps(scout_settings, indent=2))

        # Kids data (metadata, photos, embeddings)
        kids_dir = DATA_DIR / "kids"
        if kids_dir.exists():
            for f in kids_dir.rglob("*"):
                if f.is_file():
                    zf.write(f, f"kids/{f.relative_to(kids_dir)}")

    buf.seek(0)
    filename = f"scout_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/restore")
async def import_backup(file: UploadFile = File(...)):
    if not file.filename.endswith(".zip"):
        return JSONResponse(status_code=400, content={"error": "File must be a .zip"})

    content = await file.read()
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            names = zf.namelist()

            restored_settings = 0
            if "scout_settings.json" in names:
                data = json.loads(zf.read("scout_settings.json"))
                for key, value in data.items():
                    if key in SCOUT_KEYS and value is not None:
                        save_setting(key, str(value))
                        restored_settings += 1

            restored_kids = 0
            kids_dir = DATA_DIR / "kids"
            for name in names:
                if name.startswith("kids/") and not name.endswith("/"):
                    dest = kids_dir / Path(name[5:])  # strip leading "kids/"
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(zf.read(name))
                    if name.endswith("metadata.json"):
                        restored_kids += 1

    except zipfile.BadZipFile:
        return JSONResponse(status_code=400, content={"error": "Invalid zip file"})

    return {"ok": True, "restored_settings": restored_settings, "restored_kids": restored_kids}
