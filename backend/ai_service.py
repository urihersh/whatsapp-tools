import anthropic
import base64
import json
import os
import requests
import httpx

_MODEL = "claude-haiku-4-5-20251001"
_clients: dict[str, anthropic.Anthropic] = {}


def _get_client(api_key: str) -> anthropic.Anthropic:
    if api_key not in _clients:
        _clients[api_key] = anthropic.Anthropic(api_key=api_key)
    return _clients[api_key]


def _dominant_language(text: str) -> str:
    """Return the dominant non-Latin language name, or 'English' if none detected."""
    counts = {
        "Hebrew":   sum(1 for c in text if '\u0590' <= c <= '\u05FF' or '\uFB1D' <= c <= '\uFB4F'),
        "Arabic":   sum(1 for c in text if '\u0600' <= c <= '\u06FF'),
        "Russian":  sum(1 for c in text if '\u0400' <= c <= '\u04FF'),
        "Chinese":  sum(1 for c in text if '\u4E00' <= c <= '\u9FFF'),
        "Japanese": sum(1 for c in text if '\u3040' <= c <= '\u30FF'),
        "Korean":   sum(1 for c in text if '\uAC00' <= c <= '\uD7A3'),
    }
    best, n = max(counts.items(), key=lambda x: x[1])
    return best if n >= 10 else "English"


def _ollama_chat(prompt: str, ollama_url: str, model: str, system: str = "") -> str:
    url = ollama_url.rstrip("/") + "/api/chat"
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    r = requests.post(url, json={
        "model": model,
        "messages": messages,
        "stream": False,
    }, timeout=180)
    r.raise_for_status()
    return r.json()["message"]["content"].strip()


def caption_image(
    image_bytes: bytes,
    sender: str = "",
    api_key: str = "",
    ollama_url: str = "",
    ollama_vision_model: str = "llava",
) -> str:
    """Return a short caption describing what's in a group image."""
    who = f"{sender} shared this image. " if sender else ""
    prompt = (
        f"{who}In one short sentence (max 15 words), describe what is shown in this image. "
        "Be specific and factual."
    )
    key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
    if key:
        try:
            client = _get_client(key)
            msg = client.messages.create(
                model=_MODEL,
                max_tokens=80,
                messages=[{"role": "user", "content": [
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/jpeg",
                        "data": base64.b64encode(image_bytes).decode(),
                    }},
                    {"type": "text", "text": prompt},
                ]}],
            )
            return msg.content[0].text.strip()
        except Exception:
            return ""
    if ollama_url and ollama_vision_model:
        try:
            url = ollama_url.rstrip("/") + "/api/chat"
            r = requests.post(url, json={
                "model": ollama_vision_model,
                "messages": [{"role": "user", "content": prompt,
                               "images": [base64.b64encode(image_bytes).decode()]}],
                "stream": False,
            }, timeout=60)
            r.raise_for_status()
            return r.json()["message"]["content"].strip()
        except Exception:
            return ""
    return ""


def get_moment_caption(
    image_bytes: bytes,
    kid_names: list[str],
    api_key: str = "",
    ollama_url: str = "",
    ollama_vision_model: str = "llava",
) -> str:
    """Return a short warm caption for a matched photo. Uses Anthropic first, falls back to Ollama vision."""
    names = " and ".join(kid_names)
    prompt = (
        f"The child in this photo is {names}. "
        f"In one short sentence (max 15 words), describe what {names} is doing or what moment is captured. "
        f"Refer to them by name ({names}), not as 'the child' or 'a kid'. Be specific and warm."
    )

    # Anthropic
    key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
    if key:
        try:
            client = _get_client(key)
            msg = client.messages.create(
                model=_MODEL,
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
                        {"type": "text", "text": prompt},
                    ],
                }],
            )
            return msg.content[0].text.strip()
        except Exception:
            return ""

    # Ollama vision fallback
    if ollama_url and ollama_vision_model:
        try:
            url = ollama_url.rstrip("/") + "/api/chat"
            r = requests.post(url, json={
                "model": ollama_vision_model,
                "messages": [{
                    "role": "user",
                    "content": prompt,
                    "images": [base64.b64encode(image_bytes).decode()],
                }],
                "stream": False,
            }, timeout=120)
            r.raise_for_status()
            return r.json()["message"]["content"].strip()
        except Exception:
            return ""

    return ""


async def stream_summarize_ollama(transcript: str, group_name: str, ollama_url: str, ollama_model: str = "aya"):
    """Async generator that streams summary chunks from Ollama."""
    lang = _dominant_language(transcript)
    prompt = (
        f'Summarize this WhatsApp group conversation from "{group_name}" '
        f"in 3–5 bullet points in {lang}. "
        "Focus on key topics, decisions, and action items. "
        "Be concise. Format each bullet starting with •\n\n"
        f"{transcript}"
    )
    system = f"You are a summarization assistant. You must write all output in {lang} only. Do not use any other language."
    async with httpx.AsyncClient(timeout=180) as client:
        async with client.stream("POST", ollama_url.rstrip("/") + "/api/chat", json={
            "model": ollama_model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "stream": True,
        }) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if line:
                    data = json.loads(line)
                    if chunk := data.get("message", {}).get("content", ""):
                        yield chunk


def summarize_messages(
    transcript: str,
    group_name: str,
    api_key: str = "",
    ollama_url: str = "",
    ollama_model: str = "aya",
) -> str:
    """Summarize a WhatsApp group transcript. Uses Anthropic if key set, otherwise falls back to Ollama."""
    lang = _dominant_language(transcript)
    prompt = (
        f'Summarize this WhatsApp group conversation from "{group_name}" '
        f"in 3–5 bullet points in {lang}. "
        "Focus on key topics, decisions, and action items. "
        "Be concise. Format each bullet starting with •\n\n"
        f"{transcript}"
    )

    # Anthropic first
    key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
    if key:
        try:
            client = _get_client(key)
            msg = client.messages.create(
                model=_MODEL,
                max_tokens=400,
                messages=[{"role": "user", "content": prompt}],
            )
            return msg.content[0].text.strip()
        except Exception as e:
            return f"Summary failed: {e}"

    # Ollama fallback
    if ollama_url:
        try:
            system = f"You are a summarization assistant. You must write all output in {lang} only. Do not use any other language."
            return _ollama_chat(prompt, ollama_url, ollama_model or "llama3.2", system=system)
        except Exception as e:
            return f"Ollama error: {e}"

    return ""


def analyze_group_topics(
    transcript: str,
    group_name: str,
    api_key: str = "",
    ollama_url: str = "",
    ollama_model: str = "aya",
) -> str:
    """Identify the main topics discussed in a group transcript."""
    lang = _dominant_language(transcript)
    prompt = (
        f'Analyze this WhatsApp group conversation from "{group_name}".\n'
        f"Identify the 4–7 main recurring topics or themes discussed.\n"
        f"For each topic write one line: start with a relevant emoji, then the topic name, "
        f"then a colon, then a brief description (max 12 words).\n"
        f"Write in {lang}. Output only the topic lines, nothing else.\n\n"
        f"{transcript}"
    )
    key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
    if key:
        try:
            client = _get_client(key)
            msg = client.messages.create(
                model=_MODEL,
                max_tokens=600,
                messages=[{"role": "user", "content": prompt}],
            )
            return msg.content[0].text.strip()
        except Exception as e:
            return f"Analysis failed: {e}"
    if ollama_url:
        try:
            system = f"You are a conversation analyst. Write all output in {lang} only."
            return _ollama_chat(prompt, ollama_url, ollama_model or "aya", system=system)
        except Exception as e:
            return f"Ollama error: {e}"
    return ""


async def stream_analyze_ollama(transcript: str, group_name: str, ollama_url: str, ollama_model: str = "aya"):
    """Async generator that streams topic analysis chunks from Ollama."""
    lang = _dominant_language(transcript)
    prompt = (
        f'Analyze this WhatsApp group conversation from "{group_name}".\n'
        f"Identify the 4–7 main recurring topics or themes discussed.\n"
        f"For each topic write one line: start with a relevant emoji, then the topic name, "
        f"then a colon, then a brief description (max 12 words).\n"
        f"Write in {lang}. Output only the topic lines, nothing else.\n\n"
        f"{transcript}"
    )
    system = f"You are a conversation analyst. Write all output in {lang} only."
    async with httpx.AsyncClient(timeout=180) as client:
        async with client.stream("POST", ollama_url.rstrip("/") + "/api/chat", json={
            "model": ollama_model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "stream": True,
        }) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if line:
                    data = json.loads(line)
                    if chunk := data.get("message", {}).get("content", ""):
                        yield chunk


def suggest_reply(message_text: str, sender_name: str, api_key: str = "", ollama_url: str = "", ollama_model: str = "aya") -> str:
    """Suggest a short reply for an unanswered DM."""
    lang = _dominant_language(message_text)
    prompt = (
        f'You received this WhatsApp message from {sender_name}:\n"{message_text}"\n\n'
        f'Write a short, friendly, natural reply in {lang}. '
        'Just the reply text — no preamble, no quotes, no explanation.'
    )
    key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
    if key:
        try:
            client = _get_client(key)
            msg = client.messages.create(
                model=_MODEL,
                max_tokens=150,
                messages=[{"role": "user", "content": prompt}],
            )
            return msg.content[0].text.strip()
        except Exception as e:
            return f"Error: {e}"
    if ollama_url:
        try:
            system = f"You are a helpful WhatsApp assistant. Always reply in {lang}."
            return _ollama_chat(prompt, ollama_url, ollama_model or "aya", system=system)
        except Exception as e:
            return f"Ollama error: {e}"
    return ""


def agent_reply(
    prompt: str,
    history: list[dict],
    contact_name: str = "",
    contact_gender: str = "",
    api_key: str = "",
    ollama_url: str = "",
    ollama_model: str = "aya",
    system_prompt: str = "",
    is_group: bool = False,
) -> str:
    """Generate an autonomous reply for the conversation agent."""
    context = "\n".join(
        f"{'You' if h.get('fromMe') else h.get('sender', 'Them')}: {h.get('text', '')}"
        for h in history[-25:]
    ) or "(conversation just started)"

    if system_prompt:
        system = system_prompt
    elif is_group:
        system = "You are a person in a WhatsApp group chat. Write only the message text — no explanations, no meta-commentary. Be natural, like a real person texting. Match the language of the conversation."
    else:
        name_rule = f"Address the other person as \"{contact_name}\". " if contact_name else ""
        gender_rule = ""
        if contact_gender == "male":
            gender_rule = "The other person is male — use masculine forms (e.g. in Hebrew: אתה, שלך). "
        elif contact_gender == "female":
            gender_rule = "The other person is female — use feminine forms (e.g. in Hebrew: את, שלך). "
        system = f"You are a person having a WhatsApp conversation. Write only the message text — no explanations, no meta-commentary. Be natural, like a real person texting. Match the language of the conversation. {name_rule}{gender_rule}".strip()

    user_msg = (
        f"Instructions: {prompt}\n\n"
        f"Conversation so far:\n{context}\n\n"
        "Write your next message."
    )

    key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
    if key:
        try:
            client = _get_client(key)
            msg = client.messages.create(
                model=_MODEL,
                max_tokens=300,
                system=system,
                messages=[{"role": "user", "content": user_msg}],
                timeout=60.0,
            )
            return msg.content[0].text.strip()
        except Exception:
            return ""
    if ollama_url:
        try:
            return _ollama_chat(user_msg, ollama_url, ollama_model, system=system)
        except Exception:
            return ""
    return ""


def test_ollama(ollama_url: str, model: str) -> dict:
    """Test connectivity and model availability."""
    try:
        result = _ollama_chat("Reply with exactly: ok", ollama_url, model)
        return {"ok": True, "response": result}
    except requests.exceptions.ConnectionError:
        return {"ok": False, "error": f"Cannot connect to {ollama_url} — is Ollama running?"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def generate_opener(
    prompt: str,
    contact_name: str = "",
    api_key: str = "",
    ollama_url: str = "",
    ollama_model: str = "aya",
    is_group: bool = False,
) -> str:
    """Generate an opening message to start a conversation, based on agent instructions."""
    if is_group:
        system = "You are a person in a WhatsApp group chat. Write only the message text — no explanations, no meta-commentary. Be natural, like a real person texting."
    else:
        name_rule = f"Address the other person as \"{contact_name}\". " if contact_name else ""
        system = f"You are a person sending a WhatsApp message. Write only the message text — no explanations, no meta-commentary. Be natural, like a real person texting. {name_rule}".strip()

    user_msg = f"Instructions: {prompt}\n\nWrite the opening message."

    key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
    if key:
        try:
            client = _get_client(key)
            msg = client.messages.create(
                model=_MODEL,
                max_tokens=200,
                system=system,
                messages=[{"role": "user", "content": user_msg}],
            )
            return msg.content[0].text.strip()
        except Exception:
            return ""
    if ollama_url:
        try:
            return _ollama_chat(user_msg, ollama_url, ollama_model, system=system)
        except Exception:
            return ""
    return ""
