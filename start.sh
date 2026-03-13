#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Starting Parent Tool backend..."
cd "$DIR/backend"
"$DIR/.venv/bin/python" -m uvicorn main:app --reload &> /tmp/parent-tool-backend.log &
echo $! > /tmp/parent-tool-backend.pid

echo "Starting Parent Tool bot..."
cd "$DIR/bot"
node bot.js &> /tmp/parent-tool-bot.log &
echo $! > /tmp/parent-tool-bot.pid

echo "Done. Open http://localhost:8000/static/index.html"
echo "Logs: /tmp/parent-tool-backend.log and /tmp/parent-tool-bot.log"
