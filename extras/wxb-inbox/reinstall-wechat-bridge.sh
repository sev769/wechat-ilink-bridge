#!/bin/sh
# Restore the global wxb / wxb-mcp install (e.g. after a Muse VM rebuild wiped /usr
# but kept $HOME). Used by the wxb-inbox hook's self-heal step; also runnable by hand.
# Env: WXB_REPO_DIR (default ~/workspace/wechat-ilink-bridge)
set -e
REPO_DIR="${WXB_REPO_DIR:-$HOME/workspace/wechat-ilink-bridge}"
cd "$REPO_DIR"
npm install -g .
# SILK encoder: restore the durable copy if one is kept; otherwise rebuild via install.sh steps.
if [ -f "$HOME/workspace/silk-tools/encoder" ]; then
  cp "$HOME/workspace/silk-tools/encoder" /usr/local/bin/silk-encoder 2>/dev/null || cp "$HOME/workspace/silk-tools/encoder" /usr/bin/silk-encoder
  chmod +x /usr/local/bin/silk-encoder 2>/dev/null || chmod +x /usr/bin/silk-encoder
fi
wxb doctor || true
