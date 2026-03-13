# Parent Tool

A self-hosted tool that monitors WhatsApp group chats for photos of your kids. When a match is found, it forwards the photo to you with a notification.

## How it works

1. You enroll your child by uploading a few face photos
2. The bot watches the WhatsApp groups you configure (e.g. a school or activity group)
3. When a photo arrives, it runs face recognition against your enrolled kids
4. If there's a match, the photo is forwarded to you on WhatsApp with a caption like *"Emma is in this photo! (94% confidence)"*

## Features

- Face recognition using [InsightFace](https://github.com/deepinsight/insightface)
- WhatsApp integration via [Baileys](https://github.com/WhiskeySockets/Baileys)
- Multi-kid support — detects multiple kids in the same photo
- Activity log with filtering by group, kid, and match status
- Enrollment quality feedback (face size, multi-face warnings)
- Google Photos integration for auto-saving matched photos
- Dark mode
- Onboarding wizard

## Stack

| Layer | Technology |
|-------|-----------|
| Backend API | Python · FastAPI · SQLAlchemy (SQLite) |
| Face recognition | InsightFace · OpenCV · ONNX Runtime |
| WhatsApp bot | Node.js · Baileys |
| Frontend | Plain HTML · Tailwind CSS |

## Setup

### Prerequisites

- Python 3.11+
- Node.js 18+
- A WhatsApp account to use as the bot

### 1. Clone and install

```bash
git clone https://github.com/urihersh/parent-tool.git
cd parent-tool

# Python backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Node bot
cd bot && npm install && cd ..
```

### 2. Configure environment

Create a `.env` file in the project root:

```env
# Where to store the database and uploaded photos
DATA_DIR=./data

# Port for the Node bot's internal API (default 3001)
BOT_PORT=3001

# URL the Python backend uses to talk to the bot
BOT_URL=http://localhost:3001

# URL the bot uses to talk to the Python backend
PYTHON_API_URL=http://localhost:8000

# Optional: Google Photos integration
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

### 3. Start

```bash
bash start.sh
```

Then open **http://localhost:8000/static/index.html**

The first time you open the app the onboarding wizard will walk you through:
1. Linking your WhatsApp account (scan a QR code)
2. Enrolling your kid(s)
3. Adding the groups to monitor

### Stop

```bash
bash stop.sh
```

## Project structure

```
parent-tool/
├── backend/
│   ├── main.py              # FastAPI app + WhatsApp photo handler
│   ├── database.py          # SQLAlchemy models + activity log
│   ├── face_service.py      # InsightFace wrapper
│   ├── google_photos.py     # Google Photos integration
│   ├── routers/
│   │   ├── dashboard.py     # Stats + activity log API
│   │   ├── enrollment.py    # Kid enrollment API
│   │   └── settings.py      # App settings API
│   └── static/
│       ├── index.html       # Dashboard
│       ├── enrollment.html  # Kid enrollment UI
│       ├── settings.html    # Settings UI
│       ├── onboarding.html  # First-run wizard
│       ├── dark.css         # Shared dark mode styles
│       └── dark.js          # Shared dark mode logic
├── bot/
│   └── bot.js               # Baileys WhatsApp bot + Express API
├── start.sh                 # Start backend + bot
├── stop.sh                  # Stop backend + bot
└── requirements.txt
```

## Notes

- The bot appears as a **linked device** on your WhatsApp account (like WhatsApp Web). It uses `markOnlineOnConnect: false` to avoid suppressing push notifications on your phone.
- Face data is stored locally — no photos or embeddings are sent to any external service.
- The SQLite database and uploaded photos live in the `data/` directory (excluded from git).
