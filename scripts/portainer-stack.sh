#!/bin/sh
# Builds deploy/itinerary-stack.yml: a single compose file with the app embedded (no image build needed),
# for pasting or uploading into Portainer → Stacks. Data lives in the named volume and is kept across updates;
# on each new version's first start a copy of the data is saved to /data/backups/before-<version>.tgz.
set -e
cd "$(dirname "$0")/.."
VERSION="${1:-$(date +%Y%m%d-%H%M)}"
sh app/build.sh >/dev/null
TMP="$(mktemp -d)"
tar czf "$TMP/app.tgz" -C app server.js mail.js geo.js public
B64="$(base64 < "$TMP/app.tgz" | tr -d '\n')"
LEN=${#B64}; HALF=$(( (LEN + 1) / 2 ))
P1="$(printf %s "$B64" | cut -c1-$HALF)"; P2="$(printf %s "$B64" | cut -c$((HALF + 1))-)"
mkdir -p deploy
cat > deploy/itinerary-stack.yml <<YML
# Itinerary Planner ${VERSION} — Portainer stack with the app embedded (APP_TGZ + APP_TGZ2, split to stay under the 128 KB env limit).
services:
  itinerary:
    image: node:22-alpine
    container_name: itinerary
    restart: unless-stopped
    ports:
      - "\${PORT:-8095}:8080"
    environment:
      TZ: Europe/London
      DATA_DIR: /data
      BASE_URL: \${BASE_URL:-}
      APP_PASSWORD: \${APP_PASSWORD:-}
      GOOGLE_CLIENT_ID: \${GOOGLE_CLIENT_ID:-}
      GOOGLE_CLIENT_SECRET: \${GOOGLE_CLIENT_SECRET:-}
      CARTO_KEY: \${CARTO_KEY:-}
      CONTACT: \${CONTACT:-}
      APP_TGZ: "${P1}"
      APP_TGZ2: "${P2}"
    command: ["sh", "-c", "mkdir -p /data/backups && (cd /data && [ -f backups/before-${VERSION}.tgz ] || tar czf backups/before-${VERSION}.tgz \$\$(ls -A | grep -v '^backups\$\$') || true) && mkdir -p /app && printf %s%s \"\$\$APP_TGZ\" \"\$\$APP_TGZ2\" | base64 -d | tar xz -C /app && exec node /app/server.js"]
    volumes:
      - itinerary-data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
volumes:
  itinerary-data:
YML
rm -rf "$TMP"
echo "wrote deploy/itinerary-stack.yml (version ${VERSION})"
