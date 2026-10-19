#!/bin/zsh
cd "/Users/pranavgoel/Downloads/AntiGravity Reverse Engineer/glaido-replica" || exit 1

# 1. Start local SQLite + AI formatting server if not already running on 4321
if ! lsof -i :4321 >/dev/null 2>&1; then
  nohup node --no-warnings server.mjs >/tmp/glaido-open-pro.log 2>&1 &
  sleep 0.8
fi

# 2. Launch the native macOS Menu Bar + Global Auto-Type Agent (Glaido Dictate.app)
pkill -f "GlaidoDictate" 2>/dev/null || true
open -a "/Users/pranavgoel/Downloads/AntiGravity Reverse Engineer/glaido-replica/Glaido Dictate.app"

# 3. Open the Glaido Dashboard
open "http://localhost:4321"
