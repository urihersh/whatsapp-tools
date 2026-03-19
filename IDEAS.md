# WhatsApp Tools — Ideas & Product Roadmap

> Living document. Last updated: 2026-03-19
> Impact: 1–5 (5 = most impactful). Complexity: 1–5 (5 = hardest).

---

## The Privacy Problem

**The core blocker for making this a hosted service:**
Users must link their WhatsApp account (giving access to ALL messages), upload photos of their kids (biometric data), and trust a third-party server with face embeddings. That's a hard sell.

### Solution: Local-First Architecture with Optional Encrypted Cloud

The best answer is the **1Password / Obsidian model**:
- All processing (WhatsApp bot, face recognition, analytics) runs **on the user's own machine**
- A desktop app (Electron or Tauri) packages everything: Python backend + Node bot + UI
- No raw data ever leaves the device
- Cloud is *optional* — only for encrypted sync/backup between devices
  - Face embeddings are encrypted client-side before upload
  - Server is literally blind — zero-knowledge
- This means: **no privacy compromise, no liability, no GDPR headache**

**Why this works technically:**
- InsightFace runs fine on a MacBook (already doing it)
- WhatsApp Baileys session stays local
- The "cloud" only stores AES-256 encrypted blobs it cannot read
- Users own their data completely

**Business model options this enables:**
- Free self-hosted (open source, builds trust)
- Paid desktop app (one-time or subscription) — no servers to maintain per user
- Optional paid sync/backup service (encrypted, cheap to run)

---

## Section 1: Scout — Find My Kids

| # | Idea | Description | Impact | Complexity | Status |
|---|------|-------------|--------|------------|--------|
| 1 | Daily digest mode | Batch all matches into one daily/weekly summary instead of per-photo pings | 5 | 1 | ✅ Done |
| 2 | AI moment captioning | Pass matched photo to AI model: "Yoav is kicking a ball in the left corner" — included in the forwarded message | 5 | 2 | ✅ Done (Anthropic + Ollama/llava) |
| 3 | Enroll from WhatsApp | Send a photo to the bot via DM to enroll a new face. Eliminates UI friction | 4 | 2 | ✅ Done |
| 4 | Per-kid confidence threshold | Each kid gets their own tunable threshold (currently one global value for all) | 4 | 1 | |
| 5 | Multi-angle enrollment guidance | Tell users what angles are missing: "Add a side-profile", "Add an outdoor photo" | 4 | 2 | |
| 6 | Persistent message history | Store WA history in SQLite so scans survive restarts and extend further back | 4 | 3 | |
| 7 | Smart video frame sampling | Use scene-change detection instead of uniform sampling — catch faces in short clips | 3 | 3 | |
| 8 | PIN / password protection | Basic auth on the UI — anyone on the network can currently see all photos | 5 | 1 | ✅ Done |
| 9 | Activity log archiving | Auto-delete logs older than N days or export to CSV | 3 | 1 | |
| 10 | Memory Book / Timeline | Auto-generate a monthly photo book from all matches. Print-to-PDF or shareable link | 5 | 3 | |
| 11 | Desktop app packaging | Electron/Tauri app — one install, no terminal, solves the privacy problem above | 5 | 5 | |
| 12 | Unknown face clustering | Group unrecognized faces so you can easily enroll a new kid later | 3 | 3 | |
| 13 | Confidence trend tracking | Graph recognition confidence over time — detects if a kid's appearance changed | 2 | 2 | |
| 14 | Re-enroll prompts | If confidence drops on recent matches, suggest adding new enrollment photos | 3 | 2 | |
| 15 | Stranger alert | Enroll "alert faces" (not family). If they appear in monitored groups, trigger urgent alert | 4 | 2 | |
| 16 | Activity attendance log | "Yoav appeared in soccer group 8 times this month" — automated attendance from photo matches | 4 | 2 | |
| 17 | End-of-season album | Automatically compile all matched photos from a season into a shareable album when a group goes quiet | 5 | 3 | |
| 18 | Backup & Restore | Export/import Scout settings and kid enrollment data as a zip | 4 | 1 | ✅ Done |

---

## Section 2: Inbox — Unanswered DMs

| # | Idea | Description | Impact | Complexity | Status |
|---|------|-------------|--------|------------|--------|
| 19 | DM inbox tracker | Surface unread/unanswered direct messages, auto-clears on read/reply | 5 | 2 | ✅ Done |
| 20 | AI-drafted reply suggestion | When a DM is pending in inbox, suggest a reply based on the message using local AI — sent to you for approval before sending | 4 | 3 | |
| 21 | Scheduled messages | Schedule WA messages to be sent at a specific time (reminders, birthday messages) | 4 | 2 | |
| 22 | WA reminders to self | "Remind me about this in 2 hours" — forwards the message back to you via DM at the right time | 4 | 1 | |
| 23 | Smart auto-replies | Configurable away messages or keyword-triggered auto-responses for specific contacts or groups | 3 | 2 | |

---

## Section 3: Dashboard & Analytics

| # | Idea | Description | Impact | Complexity | Status |
|---|------|-------------|--------|------------|--------|
| 24 | Activity dashboard | Messages in/out, hourly chart, most active groups | 4 | 2 | ✅ Done |
| 25 | Group chat summarizer | Summarize any group in real-time with streaming output | 5 | 2 | ✅ Done (Anthropic + Ollama/aya, RTL-aware) |
| 26 | Contact activity heatmap | Who you message most by hour of day / day of week | 4 | 2 | |
| 27 | Relationship health score | Tracks response time trends to specific contacts — "You've been slower to reply to X lately" | 4 | 3 | |
| 28 | Message balance | Are you sending more than receiving in each chat? Healthy conversation balance tracker | 3 | 2 | |
| 29 | Media volume tracker | How much media is being shared per group per month | 3 | 2 | |
| 30 | "Wrapped" annual report | Spotify Wrapped-style: your WA year in review — top contacts, most active group, etc. | 5 | 3 | |
| 31 | Ghost contacts finder | People who stopped responding — surface faded relationships | 3 | 2 | |
| 32 | Best time to message X | Based on when contact is usually online/responsive — "Send this at 8 PM" | 4 | 2 | |
| 33 | Word / topic frequency | Most used words per chat (processed locally, never uploaded) | 3 | 2 | |
| 34 | Emoji personality report | What emojis define each of your relationships — fun, shareable stat card | 3 | 1 | |

---

## Section 4: AI & Smart Features

| # | Idea | Description | Impact | Complexity | Status |
|---|------|-------------|--------|------------|--------|
| 35 | Local AI (Ollama) | Free, offline AI for summarization and captions — no API key needed | 5 | 2 | ✅ Done (aya + llava, streaming) |
| 36 | Action item extractor | Scan group messages for tasks/decisions addressed to you and surface them as a to-do list | 4 | 3 | |
| 37 | Event detector | Detect event invitations and deadlines in group messages → add to Google Calendar | 4 | 3 | |
| 38 | School document auto-filer | Detect PDFs/images in school groups (permission slips, schedules) and auto-save organized by date | 5 | 3 | |
| 39 | Due date extractor | OCR + AI on school documents to extract deadlines → push to calendar | 5 | 4 | |
| 40 | Voice message transcription | Transcribe incoming voice messages to text using local Whisper — great for noisy group chats | 4 | 2 | |
| 41 | WA → Notion / Obsidian | Forward starred messages or specific chats to a notes app automatically | 4 | 2 | |

---

## Section 5: Small Business & Community

| # | Idea | Description | Impact | Complexity | Status |
|---|------|-------------|--------|------------|--------|
| 42 | Group analytics for managers | For community managers / sports coaches / HOA — who's active, who's disengaged, peak times | 4 | 3 | |
| 43 | Broadcast / newsletter tool | Send personalized one-to-many broadcasts without revealing the recipient list | 3 | 2 | |
| 44 | Payment mention tracker | Detect "I'll pay you back" messages in groups and track unresolved IOUs | 4 | 3 | |
| 45 | Poll & decision tracker | Log polls and decisions made in groups — hard to find in history later | 3 | 2 | |
| 46 | "Find this person" command | DM a photo to the bot — it scans stored group media for that face across all groups | 4 | 2 | |
| 47 | Multi-family mode | Multiple families share one bot, each only sees their own kids' photos — foundation for a service | 5 | 4 | |

---

## What to Build Next (Top Candidates)

Ranked by impact/complexity ratio, excluding already-done items:

| Priority | # | Idea | Why |
|----------|---|------|-----|
| 🥇 1 | 38 | **School document auto-filer** | Solves a daily pain point for every parent — PDFs and schedules buried in group chats |
| 🥈 2 | 40 | **Voice message transcription** | Whisper runs locally via Ollama; very practical for noisy group chats |
| 🥉 3 | 36 | **Action item extractor** | Natural extension of the summarizer — same infra, high daily value |
| 4 | 20 | **AI-drafted reply suggestion** | Completes the Inbox feature — not just track but help respond |
| 5 | 30 | **"Wrapped" annual report** | Viral, shareable, fun — marketing flywheel for open-source growth |
| 6 | 10 | **Memory Book** | High emotional value; parents will share it |
| 7 | 11 | **Desktop app packaging** | Removes terminal friction, unlocks non-technical users, enables commercial path |

---

## Architecture Note: The Path to a Product

```
Phase 1 (now):     Self-hosted, technical users, open source
Phase 2 (next):    Desktop app (Electron/Tauri) — anyone can install, still fully local
Phase 3 (later):   Optional encrypted cloud sync — multi-device, family sharing
Phase 4 (product): Multi-family SaaS — zero-knowledge, charge for sync + premium features
```

The privacy solution isn't a compromise — it's the **differentiator**.
"We literally cannot see your data" is a stronger selling point than any feature list.
