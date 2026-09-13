#!/usr/bin/env bash
# 在 Linux（或 WSL）上构建远端用 miterm-agent
# 用法:
#   ./scripts/build-agent.sh              # 宿主 glibc
#   ./scripts/build-agent.sh musl         # x86_64 musl 静态
#   ./scripts/build-agent.sh musl aarch64 # aarch64 musl

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/agent"

MODE="${1:-host}"
ARCH="${2:-x86_64}"
DIST="$ROOT/agent/dist"
mkdir -p "$DIST"

if [[ "$MODE" == "musl" ]]; then
  case "$ARCH" in
    x86_64|amd64) TARGET=x86_64-unknown-linux-musl; OUT=miterm-agent-linux-x86_64 ;;
    aarch64|arm64) TARGET=aarch64-unknown-linux-musl; OUT=miterm-agent-linux-aarch64 ;;
    *) echo "unknown arch: $ARCH"; exit 1 ;;
  esac
  rustup target add "$TARGET"
  if ! command -v musl-gcc >/dev/null 2>&1 && [[ "$ARCH" == "x86_64" || "$ARCH" == "amd64" ]]; then
    echo "hint: sudo apt install musl-tools"
  fi
  cargo build --release --target "$TARGET"
  cp -f "target/$TARGET/release/miterm-agent" "$DIST/$OUT"
  chmod +x "$DIST/$OUT"
  echo "OK: $DIST/$OUT"
  "$DIST/$OUT" --version || true
else
  cargo build --release
  cp -f target/release/miterm-agent "$DIST/miterm-agent-linux-$(uname -m)"
  chmod +x "$DIST/miterm-agent-linux-$(uname -m)"
  echo "OK: $DIST/miterm-agent-linux-$(uname -m)"
  "./target/release/miterm-agent" --version
fi
