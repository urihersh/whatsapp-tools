from sqlalchemy import create_engine, Column, Integer, String, Boolean, Float, DateTime, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime
from pathlib import Path
import os
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent.parent / ".env")

DATA_DIR = Path(os.getenv("DATA_DIR", "./data")).resolve()
DB_PATH = DATA_DIR / "parenttool.db"

engine = None
SessionLocal = None
Base = declarative_base()


class ActivityLog(Base):
    __tablename__ = "activity_log"
    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
    photo_filename = Column(String)
    sender = Column(String)
    group_name = Column(String)
    faces_detected = Column(Integer, default=0)
    matched = Column(Boolean, default=False)
    confidence = Column(Float, default=0.0)
    forwarded = Column(Boolean, default=False)
    kid_names = Column(String, default="")
    matched_photo_path = Column(String, default="")
    thumbnail_filename = Column(String, default="")


class AppConfig(Base):
    __tablename__ = "app_config"
    key = Column(String, primary_key=True)
    value = Column(String)


def init_db():
    global engine, SessionLocal
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{DB_PATH}",
        connect_args={"check_same_thread": False}
    )
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    # Migrate: add kid_names column if it doesn't exist
    with engine.connect() as conn:
        try:
            conn.execute(text("ALTER TABLE activity_log ADD COLUMN kid_names TEXT DEFAULT ''"))
            conn.commit()
        except OperationalError as e:
            if "duplicate column" not in str(e).lower() and "already has column" not in str(e).lower():
                raise
    with engine.connect() as conn:
        try:
            conn.execute(text("ALTER TABLE activity_log ADD COLUMN matched_photo_path TEXT DEFAULT ''"))
            conn.commit()
        except OperationalError as e:
            if "duplicate column" not in str(e).lower() and "already has column" not in str(e).lower():
                raise
    with engine.connect() as conn:
        try:
            conn.execute(text("ALTER TABLE activity_log ADD COLUMN thumbnail_filename TEXT DEFAULT ''"))
            conn.commit()
        except OperationalError as e:
            if "duplicate column" not in str(e).lower() and "already has column" not in str(e).lower():
                raise


def get_settings() -> dict:
    db = SessionLocal()
    try:
        rows = db.query(AppConfig).all()
        return {row.key: row.value for row in rows}
    finally:
        db.close()


def save_setting(key: str, value: str):
    db = SessionLocal()
    try:
        existing = db.query(AppConfig).filter(AppConfig.key == key).first()
        if existing:
            existing.value = value
        else:
            db.add(AppConfig(key=key, value=value))
        db.commit()
    finally:
        db.close()


def log_activity(photo_filename: str, sender: str, group_name: str,
                 faces_detected: int, matched: bool, confidence: float, forwarded: bool,
                 kid_names: str = "", matched_photo_path: str = "", thumbnail_filename: str = ""):
    db = SessionLocal()
    try:
        db.add(ActivityLog(
            photo_filename=photo_filename,
            sender=sender,
            group_name=group_name,
            faces_detected=faces_detected,
            matched=matched,
            confidence=confidence,
            forwarded=forwarded,
            kid_names=kid_names,
            matched_photo_path=matched_photo_path,
            thumbnail_filename=thumbnail_filename,
        ))
        db.commit()
    finally:
        db.close()


def get_activity_log(limit: int = 50, matched: bool | None = None,
                     group_name: str = "", kid_name: str = "") -> list:
    db = SessionLocal()
    try:
        query = db.query(ActivityLog).order_by(ActivityLog.timestamp.desc())
        if matched is not None:
            query = query.filter(ActivityLog.matched == matched)
        if group_name:
            query = query.filter(ActivityLog.group_name.ilike(f"%{group_name}%"))
        if kid_name:
            query = query.filter(ActivityLog.kid_names.ilike(f"%{kid_name}%"))
        rows = query.limit(limit).all()
        return [
            {
                "id": r.id,
                "timestamp": r.timestamp.isoformat(),
                "photo_filename": r.photo_filename,
                "sender": r.sender,
                "group_name": r.group_name,
                "faces_detected": r.faces_detected,
                "matched": r.matched,
                "confidence": r.confidence,
                "forwarded": r.forwarded,
                "kid_names": r.kid_names or "",
                "matched_photo_path": r.matched_photo_path or "",
                "thumbnail_filename": r.thumbnail_filename or "",
            }
            for r in rows
        ]
    finally:
        db.close()


def clear_activity_log():
    db = SessionLocal()
    try:
        db.query(ActivityLog).delete()
        db.commit()
    finally:
        db.close()


def get_stats() -> dict:
    db = SessionLocal()
    try:
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        total = db.query(ActivityLog).count()
        total_matched = db.query(ActivityLog).filter(ActivityLog.matched == True).count()
        today_total = db.query(ActivityLog).filter(ActivityLog.timestamp >= today).count()
        today_matched = db.query(ActivityLog).filter(
            ActivityLog.matched == True,
            ActivityLog.timestamp >= today
        ).count()
        return {
            "total_processed": total,
            "total_matched": total_matched,
            "total_unmatched": total - total_matched,
            "today_matched": today_matched,
            "today_unmatched": today_total - today_matched,
        }
    finally:
        db.close()
