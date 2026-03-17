from fastapi import APIRouter
from pydantic import BaseModel
from database import get_settings

router = APIRouter(tags=["auth"])


@router.get("/status")
async def auth_status():
    s = get_settings()
    return {"pin_enabled": s.get("pin_enabled") == "true"}


class PinVerify(BaseModel):
    pin: str


@router.post("/verify")
async def verify_pin(body: PinVerify):
    s = get_settings()
    if s.get("pin_enabled") != "true":
        return {"ok": True}
    return {"ok": body.pin == s.get("app_pin", "")}
