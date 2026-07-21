#!/bin/sh
set -e

# The container starts as root purely to fix up the data volume, then drops to
# the unprivileged `node` user before running the app.
#
# Why this can't just be `USER node` in the Dockerfile: a named volume only
# inherits ownership from the image when Docker creates it empty. A volume left
# over from an earlier version of this image — one that ran as root — stays
# root-owned, and the app would start fine but fail on the first write. Doing
# the chown here fixes existing installs on the next `docker compose up`.
if [ "$(id -u)" = "0" ]; then
  DATA_DIR="$(dirname "${DATA_FILE:-/data/clocker.json}")"
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"
