#!/usr/bin/env bash
# Assemble + deploy donut-sync (self-hosted token mode) to a remote host over SSH.
#
#   Usage:  ./deploy.sh root@YOUR_SERVER_IP
#
# Requires a filled-in `.env` next to this script (see .env.prod.example).
# Idempotent: re-run to redeploy after editing source or .env.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:?usage: ./deploy.sh user@host}"
REMOTE_DIR="/opt/donut-sync"

[ -f "$HERE/.env" ] || { echo "ERROR: $HERE/.env missing. Copy .env.prod.example -> .env and fill secrets."; exit 1; }

# Assemble a clean deploy dir: compose + .env at the root, source under donut-sync/
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/donut-sync"
cp "$HERE/package.json" "$HERE/tsconfig.json" "$HERE/tsconfig.build.json" "$HERE/Dockerfile" "$STAGE/donut-sync/"
cp -R "$HERE/src" "$STAGE/donut-sync/src"
cp "$HERE/docker-compose.prod.yml" "$STAGE/docker-compose.yml"
cp "$HERE/.env" "$STAGE/.env"

TARBALL="$STAGE/../donut-sync-deploy.$$.tgz"
tar czf "$TARBALL" -C "$STAGE" .

echo ">> uploading to $TARGET:$REMOTE_DIR"
scp "$TARBALL" "$TARGET:/root/donut-sync-deploy.tgz"
ssh "$TARGET" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR && tar xzf /root/donut-sync-deploy.tgz -C $REMOTE_DIR && cd $REMOTE_DIR && docker compose up -d --build && sleep 3 && curl -sf http://127.0.0.1:12342/readyz && echo && echo '>> deployed. remember to open ports 12342 + 9000 in the cloud firewall.'"
rm -f "$TARBALL"
