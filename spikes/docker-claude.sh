#!/usr/bin/env bash
# Run `claude "$@"` inside the base image with path-parity mounts.
# Env: SPIKE_NAME (container name), SPIKE_CWD (workdir, mounted at the same path),
#      SPIKE_CFG (config dir, mounted at the same path), SPIKE_EXTRA_MOUNTS (space-separated host paths, same path)
set -euo pipefail
mounts=(-v "$SPIKE_CWD:$SPIKE_CWD" -v "$SPIKE_CFG:$SPIKE_CFG")
for m in ${SPIKE_EXTRA_MOUNTS:-}; do mounts+=(-v "$m:$m"); done
exec docker run -i --name "$SPIKE_NAME" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -e CLAUDE_CONFIG_DIR="$SPIKE_CFG" ${SPIKE_DOCKER_ENV:-} \
  "${mounts[@]}" -w "$SPIKE_CWD" open-factory-base:dev claude "$@"
