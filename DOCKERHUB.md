# Clocker

A small, self-hosted time tracker for logging hours against a weekly target (default 8h/week). Start a live shift stopwatch or type entries by hand, and see your week's progress, days logged, and a history of past weeks. Data is stored server-side in a JSON file, so it's shared across every browser and device pointing at the server — not trapped in one browser's local storage.

Tiny Node/Express app, no database, no external services.

- **Source & full docs:** https://github.com/Iwe-Coumou/clocker

> **Note:** The idea, features, and design are mine; the code itself was written entirely by Claude (Anthropic's AI) from my instructions — I didn't hand-write any of it. It's a small tool that works well for what it does, but treat it accordingly.

## Quick start

```bash
docker run -d --name clocker \
  -p 8090:3000 \
  -v clocker-data:/data \
  --restart unless-stopped \
  icoumou/clocker:latest
```

Then open **http://localhost:8090**. The `clocker-data` volume is created automatically on first run — there's nothing to set up beforehand.

## Keep the `-v` flag — it's how your data survives updates

The app writes to `/data/clocker.json` inside the container. **Without `-v clocker-data:/data`, that file lives in the container's writable layer**, and `docker rm` destroys it. Since updating to a newer image is a `docker rm` plus a fresh `docker run`, the first update would silently take every logged hour with it. The named volume keeps the data outside the container so a new one picks it back up.

If you've already been running without a volume, you don't have to lose anything: **Contract & data → Export backup** in the app, recreate the container with the `-v` flag, then **Import backup**. That's also how you move a ledger between machines — each host's volume is its own separate ledger.

## Optional login

There's no login by default — fine on a home LAN or Tailscale. To require one, pass credentials when you create the container:

```bash
docker run -d --name clocker \
  -p 8090:3000 \
  -v clocker-data:/data \
  -e AUTH_USER=yourname -e AUTH_PASS=something-not-guessable \
  --restart unless-stopped \
  icoumou/clocker:latest
```

Every request then needs that username/password (HTTP Basic Auth). Environment variables are fixed when the container is created, so changing them later means removing and re-running the container — safe, since the data is in the volume. Basic Auth sends credentials base64-encoded, not encrypted, so put a reverse proxy with HTTPS in front if you ever expose this beyond a trusted network.

## With Docker Compose

Same setup, but the file remembers your settings across updates — worth it for anything you keep running:

```yaml
services:
  clocker:
    image: icoumou/clocker:latest
    container_name: clocker
    ports:
      # Host side only — change 8090 if it's taken. The app always listens
      # on 3000 inside the container.
      - "8090:3000"
    environment:
      - AUTH_USER=${AUTH_USER:-}
      - AUTH_PASS=${AUTH_PASS:-}
    volumes:
      - clocker-data:/data
    restart: unless-stopped

volumes:
  clocker-data:
```

Save as `docker-compose.yml` and run `docker compose up -d`. It works as-is with no login; to turn auth on, put an `.env` file next to it with `AUTH_USER=` / `AUTH_PASS=` lines.

## Configuration

| Setting | How | Default |
|---|---|---|
| Host port | `-p <port>:3000` | — (map to 8090) |
| Data location | `-v clocker-data:/data` | container layer (not persistent) |
| Login user | `-e AUTH_USER=` | unset (no login) |
| Login password | `-e AUTH_PASS=` | unset (no login) |

The app always listens on port **3000** inside the container; map it to whatever host port you like. Weekly target and week-start day are set in the app itself (Contract & data).

## Tags

- `latest` — the newest release. Convenient, but it moves under you without warning; pin a version for anything you rely on.
- `1.3.0`, `1.2.1`, … — specific releases. Multi-arch: `linux/amd64` and `linux/arm64` (works on a Raspberry Pi, Synology, or Apple Silicon).

## Changelog

- **1.3.0** — Merge import: add another machine's exported hours to an existing install without replacing anything (entries already present are skipped). A version footer links back to the source and this page.
- **1.2.1** — Durations are now stored as whole minutes, fixing weekly totals that drifted when an entry was edited (a one-minute edit could move a total by two). Entries from older versions are rounded to the nearest minute on first start. CSV export gains an exact `minutes` column.
- **1.2.0** — Live shift stopwatch with pause/resume, day ledger with inline editing, week history, JSON/CSV export and import, optional Basic Auth.
