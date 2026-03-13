from fastapi import APIRouter
from pathlib import Path
from typing import Optional
import os
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent.parent.parent / ".env")

from database import get_stats, get_activity_log, clear_activity_log

DATA_DIR = Path(os.getenv("DATA_DIR", "./data")).resolve()

router = APIRouter(tags=["dashboard"])


@router.get("/stats")
async def stats():
    s = get_stats()
    kids_dir = DATA_DIR / "kids"
    s["enrolled_photos"] = len(list(kids_dir.glob("*/embeddings/*.npy"))) if kids_dir.exists() else 0
    return s


@router.get("/activity")
async def activity(limit: int = 50, matched: Optional[bool] = None,
                   group_name: str = "", kid_name: str = ""):
    return {"activity": get_activity_log(limit, matched=matched, group_name=group_name, kid_name=kid_name)}


@router.delete("/activity")
async def delete_activity():
    clear_activity_log()
    return {"ok": True}
