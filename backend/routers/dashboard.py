from fastapi import APIRouter
from fastapi.responses import Response, FileResponse
from pathlib import Path
from typing import Optional
from datetime import datetime
from collections import defaultdict, Counter
import os
import httpx
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent.parent.parent / ".env")

from database import get_stats, get_activity_log, clear_activity_log, ActivityLog
import database as _db

def SessionLocal():
    return _db.SessionLocal()

DATA_DIR = Path(os.getenv("DATA_DIR", "./data")).resolve()

router = APIRouter(tags=["dashboard"])

MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


BOT_API_URL = os.getenv("BOT_API_URL", "http://localhost:3001")


@router.get("/home-stats")
async def home_stats():
    """Combined WA message stats + Scout today stats for the Home page."""
    wa = {"today": {"received": 0, "sent": 0, "media": 0}, "groups": [], "hourly": [], "total_groups": 0, "active_today": 0}
    try:
        async with httpx.AsyncClient(timeout=5.0) as hx:
            r = await hx.get(f"{BOT_API_URL}/message-stats")
            wa = r.json()
    except Exception:
        pass

    db = SessionLocal()
    try:
        today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        rows = db.query(ActivityLog).filter(ActivityLog.timestamp >= today_start).all()
        scout = {
            "scanned_today": len(rows),
            "matched_today": sum(1 for r in rows if r.matched),
        }
    finally:
        db.close()

    return {"wa": wa, "scout": scout}


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


@router.get("/wrapped")
async def wrapped(year: int = None):
    """Return yearly stats for the Wrapped report."""
    target_year = year or datetime.now().year
    db = SessionLocal()
    try:
        rows = db.query(ActivityLog).filter(
            ActivityLog.timestamp >= datetime(target_year, 1, 1),
            ActivityLog.timestamp < datetime(target_year + 1, 1, 1),
        ).all()
    finally:
        db.close()

    if not rows:
        return {"year": target_year, "total_scanned": 0, "total_matched": 0,
                "match_rate": 0, "monthly_counts": [], "top_groups": [],
                "top_kids": [], "best_month": None, "most_active_dow": None}

    total_scanned = len(rows)
    matched_rows = [r for r in rows if r.matched]
    total_matched = len(matched_rows)
    match_rate = round(total_matched / total_scanned * 100, 1) if total_scanned else 0

    # Monthly breakdown
    monthly: dict[int, dict] = {i: {"scanned": 0, "matched": 0} for i in range(1, 13)}
    for r in rows:
        m = r.timestamp.month
        monthly[m]["scanned"] += 1
        if r.matched:
            monthly[m]["matched"] += 1
    monthly_counts = [
        {"month": MONTH_NAMES[i - 1], "month_num": i, **monthly[i]}
        for i in range(1, 13)
    ]

    # Top groups
    group_counter: Counter = Counter()
    for r in matched_rows:
        if r.group_name:
            group_counter[r.group_name] += 1
    top_groups = [{"name": n, "matched": c} for n, c in group_counter.most_common(5)]

    # Top kids
    kid_counter: Counter = Counter()
    for r in matched_rows:
        for name in (r.kid_names or "").split(","):
            name = name.strip()
            if name:
                kid_counter[name] += 1
    top_kids = [{"name": n, "count": c} for n, c in kid_counter.most_common(5)]

    # Best month (only meaningful when there are matches)
    if total_matched > 0:
        best_m = max(range(1, 13), key=lambda i: monthly[i]["matched"])
        best_month = {"month": MONTH_NAMES[best_m - 1], "count": monthly[best_m]["matched"]}
    else:
        best_month = None

    # Most active day of week
    dow_counter: Counter = Counter()
    dow_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    for r in matched_rows:
        dow_counter[r.timestamp.weekday()] += 1
    if dow_counter:
        most_active_dow = dow_names[dow_counter.most_common(1)[0][0]]
    else:
        most_active_dow = None

    return {
        "year": target_year,
        "total_scanned": total_scanned,
        "total_matched": total_matched,
        "match_rate": match_rate,
        "monthly_counts": monthly_counts,
        "top_groups": top_groups,
        "top_kids": top_kids,
        "best_month": best_month,
        "most_active_dow": most_active_dow,
    }


@router.get("/memory-book")
async def memory_book(year: int = None, month: int = None):
    """Return matched activity log entries grouped by month for the memory book."""
    db = SessionLocal()
    try:
        query = db.query(ActivityLog).filter(ActivityLog.matched == True)
        if year:
            query = query.filter(
                ActivityLog.timestamp >= datetime(year, 1, 1),
                ActivityLog.timestamp < datetime(year + 1, 1, 1),
            )
        if month:
            if not year:
                year = datetime.now().year
            next_month = month % 12 + 1
            next_year = year + 1 if month == 12 else year
            query = query.filter(
                ActivityLog.timestamp >= datetime(year, month, 1),
                ActivityLog.timestamp < datetime(next_year, next_month, 1),
            )
        rows = query.order_by(ActivityLog.timestamp.desc()).limit(500).all()
    finally:
        db.close()

    # Group by (year, month)
    groups: dict[tuple, list] = defaultdict(list)
    for r in rows:
        key = (r.timestamp.year, r.timestamp.month)
        has_photo = bool(r.matched_photo_path and Path(r.matched_photo_path).exists())
        groups[key].append({
            "id": r.id,
            "timestamp": r.timestamp.isoformat(),
            "photo_filename": r.photo_filename,
            "sender": r.sender,
            "group_name": r.group_name,
            "kid_names": r.kid_names or "",
            "confidence": r.confidence,
            "has_photo": has_photo,
        })

    months_list = []
    for (y, m) in sorted(groups.keys(), reverse=True):
        months_list.append({
            "year": y,
            "month": m,
            "label": f"{MONTH_NAMES[m - 1]} {y}",
            "entries": groups[(y, m)],
        })

    return {"months": months_list}


@router.get("/memory-book/photo/{activity_id}")
async def memory_book_photo(activity_id: int):
    """Serve the saved photo for a memory book entry."""
    db = SessionLocal()
    try:
        row = db.query(ActivityLog).filter(ActivityLog.id == activity_id).first()
    finally:
        db.close()
    if not row or not row.matched_photo_path:
        return Response(status_code=404)
    p = Path(row.matched_photo_path)
    if not p.exists():
        return Response(status_code=404)
    return FileResponse(str(p), headers={"Cache-Control": "max-age=86400"})
