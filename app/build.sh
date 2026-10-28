#!/bin/sh
# Builds public/index.html from the planner page (../web/itinerary.html) plus the self-host adapter (host.js)
set -e
cd "$(dirname "$0")"
{
  printf '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
  printf '<meta name="theme-color" content="#ff5a36"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest">\n'
  printf '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%%}[hidden]{display:none!important}</style>\n'
  printf '<script>\n'; cat host.js; printf '</script></head><body>\n'
  cat ../web/itinerary.html
  printf '\n</body></html>\n'
} > public/index.html
echo "built public/index.html"
