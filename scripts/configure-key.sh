#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${1:-}" = "--check-only" ]; then
  exec node "$SCRIPT_DIR/codex-setup.mjs" --configure-key --check-only
fi
umask 077
main_key=""
native_key=""
if [ "${1:-}" != "--native-only" ]; then
  printf '%s' 'gpt-image-2 API key (Enter to keep current): '
  stty -echo
  IFS= read -r main_key || true
  stty echo
  printf '\n'
fi
printf '%s' 'Optional gpt-image-1.5 API key (Enter to skip): '
stty -echo
IFS= read -r native_key || true
stty echo
printf '\n'
if [ -z "$main_key" ] && [ -z "$native_key" ]; then
  exec node "$SCRIPT_DIR/codex-setup.mjs" --configure-key --check-only
fi
AIFORALL_SETUP_MAIN_KEY="$main_key" AIFORALL_SETUP_NATIVE_KEY="$native_key" \
  node "$SCRIPT_DIR/codex-setup.mjs" --configure-key
