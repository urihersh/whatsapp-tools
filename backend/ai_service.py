# Requires ANTHROPIC_API_KEY in your .env file
import anthropic
import base64
import os

_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic | None:
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY", "")
        if not api_key:
            return None
        _client = anthropic.Anthropic(api_key=api_key)
    return _client


def get_moment_caption(image_bytes: bytes, kid_names: list[str]) -> str:
    """Call Claude Haiku with the matched photo and return a short warm caption."""
    client = _get_client()
    if not client:
        return ""
    try:
        names = " and ".join(kid_names)
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=80,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": base64.b64encode(image_bytes).decode(),
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            f"{names} appear in this photo. "
                            "In one short sentence (max 15 words), describe what activity or moment is shown. "
                            "Be specific and warm."
                        ),
                    },
                ],
            }],
        )
        return msg.content[0].text.strip()
    except Exception:
        return ""


def summarize_messages(transcript: str, group_name: str) -> str:
    """Summarize a WhatsApp group transcript into bullet points."""
    client = _get_client()
    if not client:
        return "ANTHROPIC_API_KEY not set in .env"
    try:
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            messages=[{
                "role": "user",
                "content": (
                    f"Summarize this WhatsApp group conversation from \"{group_name}\" "
                    "in 3–5 bullet points. Focus on key topics, decisions, and action items. "
                    "Be concise. Format each bullet starting with • \n\n"
                    f"{transcript}"
                ),
            }],
        )
        return msg.content[0].text.strip()
    except Exception as e:
        return f"Summary failed: {e}"
