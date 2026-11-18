#!/usr/bin/env bash
# `claude "$@"` via `docker exec -i` into a long-lived agent container (started separately with
# `docker run -d ... open-factory-base:dev`, CMD sleep infinity). Env: SPIKE_NAME, SPIKE_CWD, SPIKE_CFG.
set -euo pipefail
exec docker exec -i -u agent -e CLAUDE_CONFIG_DIR="$SPIKE_CFG" -w "$SPIKE_CWD" "$SPIKE_NAME" claude "$@"
