#!/usr/bin/env bash
# Start the belt page. Default http://127.0.0.1:8095
#   scripts/belt.sh                       # 127.0.0.1:8095
#   scripts/belt.sh --host 0.0.0.0        # or BELT_HOST=0.0.0.0 (only on a network you trust)
#   BELT_PORT=8096 scripts/belt.sh
set -euo pipefail
cd "$(dirname "$0")/.."
exec uv run python -m belt.server "$@"
