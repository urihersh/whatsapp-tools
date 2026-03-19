# WhatsApp Tools

A self-hosted toolkit for your WhatsApp. Runs entirely on your own machine — no data leaves your device.

## What it does

### Scout — Find your kids in group photos
Watches the WhatsApp groups you configure (school, sports, activities). When a photo arrives, it runs face recognition and forwards any matches to you with a confidence score and an optional AI-generated caption.

### Inbox — Unanswered DM tracker
Tracks direct messages you haven't replied to. Clears automatically when you read or reply to the chat. Supports snooze, ignore, and WA self-message reminders.

### Dashboard — Group analytics
Message activity by hour, most active groups, messages in/out stats. Summarize any group conversation in seconds using local AI (Ollama) or Anthropic.

### Settings — One place to configure everything
WhatsApp connection (QR scan), integrations (Anthropic, Google Photos, Ollama), PIN lock, backup & restore.

---

## Features

| | Feature |
|---|---------|
| 👁️ | Face recognition on incoming WhatsApp photos and videos |
| 📲 | Instant forward of matched photos to your phone |
| 🤖 | AI moment captions — local (llava) or cloud (Claude) |
| 📝 | Group chat summarizer — streams in real-time |
| 📥 | DM inbox — unread tracker with snooze and reminders |
| 📊 | Dashboard with activity charts and group stats |
| 🖼️ | Google Photos auto-save for matched photos |
| 🔒 | PIN lock for local network access control |
| 💾 | Backup & restore (Scout settings + kid enrollment data) |
| 🌙 | Dark mode |
| 🦙 | Ollama support — run AI fully offline, free |

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend API | Python · FastAPI · SQLAlchemy (SQLite) |
| Face recognition | InsightFace · OpenCV · ONNX Runtime |
| WhatsApp bot | Node.js · Baileys (linked device) |
| Frontend | Plain HTML · Tailwind CSS |
| Local AI | Ollama (llama/aya for text, llava for vision) |
| Cloud AI | Anthropic Claude (optional) |

---

## Setup

### Prerequisites

- Python 3.11+
- Node.js 18+
- A WhatsApp account to link as the bot

### 1. Clone and install

```bash
git clone https://github.com/urihersh/whatsapp-tools.git
cd whatsapp-tools

# Python backend
python3 -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Node bot
cd bot && npm install && cd ..
```

### 2. Start

```bash
bash start.sh
```

Then open **http://localhost:8000/static/index.html**

The onboarding wizard walks you through:
1. Linking your WhatsApp account (scan QR code)
2. Enrolling your kid(s) with a few face photos
3. Choosing which groups to monitor

### Stop

```bash
bash stop.sh
```

### Optional: Local AI (free, no API key needed)

**macOS** (Homebrew):
```bash
brew install ollama
brew services start ollama
ollama pull aya          # text summarization
ollama pull llava        # photo captions (vision)
```

**Raspberry Pi / Linux:**
```bash
sudo bash scripts/setup-ollama-rpi.sh
```

**Windows:**
```powershell
# Run as Administrator
.\scripts\setup-ollama-windows.ps1
```

Then go to **Settings → Integrations → Ollama**, enter `http://localhost:11434`, and hit **Test Connection**.

---

## Project structure

```
whatsapp-tools/
├── backend/
│   ├── main.py              # FastAPI app, WhatsApp media handler, DM inbox proxy
│   ├── database.py          # SQLAlchemy models, activity log, settings store
│   ├── ai_service.py        # Anthropic + Ollama: captions, summarization, streaming
│   ├── face_service.py      # InsightFace wrapper
│   ├── google_photos.py     # Google Photos OAuth + upload
│   ├── routers/
│   │   ├── dashboard.py     # Stats + activity log API
│   │   ├── settings.py      # App settings API + WhatsApp status/QR
│   │   ├── enrollment.py    # Kid enrollment API
│   │   └── backup.py        # Backup & restore (zip)
│   └── static/
│       ├── index.html       # Dashboard (stats, summarizer)
│       ├── scout.html       # Scout app (scan, configure, activity log)
│       ├── inbox.html       # DM inbox
│       ├── settings.html    # Platform settings
│       ├── onboarding.html  # First-run wizard
│       ├── kbd-nav.js       # Keyboard navigation for search dropdowns
│       ├── dark.css / dark.js
│       └── pin_lock.js
├── bot/
│   └── bot.js               # Baileys bot, DM inbox tracking, text/media history
├── scripts/
│   ├── setup-ollama-rpi.sh  # Ollama installer for Raspberry Pi / Linux
│   └── setup-ollama-windows.ps1
├── start.sh / stop.sh
└── requirements.txt
```

---

## Notes

- The bot runs as a **linked device** on your WhatsApp account (like WhatsApp Web). It uses `markOnlineOnConnect: false` so your phone still receives push notifications normally.
- **No data leaves your device.** Face embeddings, photos, and message metadata are stored in the local `data/` directory (git-ignored).
- The `data/` directory is created automatically on first run.
