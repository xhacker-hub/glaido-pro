#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "/Users/pranavgoel/Downloads/AntiGravity Reverse Engineer/glaido-replica" || exit 1
while true; do
  /opt/homebrew/bin/node --no-warnings server.mjs >>/tmp/glaido-pro.log 2>&1
  sleep 1
done
