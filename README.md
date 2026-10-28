# Itinerary Planner

A self-hosted trip planner with a Google-Calendar-style day view. Pick the days of a trip, drop plans into hourly slots, pull in your Google Calendar and Gmail booking confirmations, and see how you'll get between everything — walking, driving, cycling, the London Underground or public transport anywhere Transitous has timetables.

Single Node.js server, no dependencies, data stored as JSON files. Runs in Docker.

## Features

- **Trips and days** — choose the days to include; Day, 3-day, whole-trip, List and Map views; works on phones.
- **Plans** — add, drag to move, drag the top or bottom edge to resize (hold to pick up on touch screens), runs past midnight, all-day items, planned vs confirmed, colour keys.
- **Google Calendar** — link any number of Google accounts (each person links their own), choose whose calendars show on each trip, edit events you own, adjust others' events locally in the planner.
- **Gmail bookings** — finds booking confirmations (tickets, tables, hotels) dated on the trip days and offers them as plans. Only dates this year or later count.
- **Travel between stops** — each journey fills its real time in the calendar and glows red when you'd be late for the next item. Change the transport per journey or for the whole trip, or remove a journey.
  - Walk / drive / cycle: OSRM routing.
  - Tube: London Underground planner on TfL line data with live status, alternative routes, avoid lines or stations.
  - Public transport: trains, buses, metro, trams and ferries via [Transitous](https://transitous.org), with platforms, departure times and every stop.
  - Each morning starts from the hotel you stayed in (items keyed **Stay**).
- **Map** — clean CARTO Voyager map, lettered stops, every journey drawn in its line colours.
- **Your places** — a shared list of saved spots to add to or remove from the plan; imports a Things To Do backup.
- **Place search** — OpenStreetMap plus every UK postcode via postcodes.io.
- **Accounts** — multiple users with passwords; admin settings for Google sign-in, map key and people.

## Quick start

```sh
cp .env.example .env        # optional, everything can be set later in Settings
docker compose up -d --build
```

Open http://localhost:8095. The first visit creates the admin account (or set `APP_PASSWORD` to create user `admin` with that password).

## Configuration

| Variable | What it's for |
|---|---|
| `PORT` | Host port (default 8095) |
| `BASE_URL` | Public address, e.g. `https://trips.example.com`; used for Google sign-in redirects |
| `APP_PASSWORD` | Creates the first `admin` account on first start |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client (or enter in Settings → Google Calendar) |
| `CARTO_KEY` | Free CARTO basemaps key (or enter in Settings → Map) |
| `CONTACT` | Email or website sent to Transitous with each search, as their usage policy asks |
| `DATA_DIR` | Where data is kept (default `/data`) |

### Google Calendar and Gmail

1. In Google Cloud Console create a project and enable the **Google Calendar API** and **Gmail API**.
2. OAuth consent screen: External, then **Publish app** (in Testing mode links expire after 7 days).
3. Create an OAuth client ID (Web application) with the redirect URI shown in Settings → Google Calendar, i.e. `BASE_URL/auth/google/callback`.
4. Paste the client ID and secret into Settings → Google Calendar. Each person then links their own account there.

Scopes requested: calendar (read/write), Gmail read-only (only to find booking confirmations), email.

### Map tiles

CARTO no longer serves tiles without a key. Request a free one at https://carto.com/basemaps/apikey/ (non-commercial use) and paste it into Settings → Map. Without a key the map falls back to OpenStreetMap's standard tiles.

## Deploying with Portainer (no image build)

```sh
sh scripts/portainer-stack.sh v5
```

This writes `deploy/itinerary-stack.yml` with the app embedded, ready to paste into Portainer → Stacks → Editor. Data lives in the named volume, so updating the stack keeps it, and the first start of each version saves a copy to `/data/backups/before-<version>.tgz`.

## Project layout

```
app/server.js      HTTP server: accounts, sessions, data, Google OAuth + Calendar proxy, settings
app/mail.js        Gmail booking search and date extraction
app/geo.js         place search (Nominatim + postcodes.io), routing (OSRM), public transport (Transitous), caching
app/host.js        browser adapter (server-backed store, Google bridge, Settings screens)
app/build.sh       builds app/public/index.html from web/itinerary.html + host.js
app/public/        icon, manifest, vendored Leaflet 1.9.4
web/itinerary.html the planner page (UI, calendar, travel, Tube planner, map)
scripts/           Portainer stack generator
```

Data files in `DATA_DIR`: `state.json` (trips, items, places), `users.json` (scrypt-hashed passwords), `google.json` (linked accounts' tokens), `config.json`, `secret` (session signing key), `geocache.json`. Back these up; never commit them.

## Third-party services and credits

- Map data © OpenStreetMap contributors; map tiles © CARTO
- Place search: OpenStreetMap Nominatim (max 1 request/second, cached); UK postcodes: postcodes.io (Royal Mail / ONS data under the Open Government Licence)
- Routing: routing.openstreetmap.de (OSRM)
- Tube: Transport for London Unified API (powered by TfL Open Data)
- Public transport: Transitous and its data sources (non-commercial use; about 700 searches a day, cached for 6 hours)
- [Leaflet](https://leafletjs.com) 1.9.4, BSD-2-Clause, vendored in `app/public/vendor`
