# Clocker (self-hosted)

> **Note:** This was a quick practical tool built entirely with Claude (Anthropic's AI) — not hand-coded. It works, but treat it accordingly if you're evaluating it as a code sample or handing it off to someone else.

A small timecard for tracking hours against a weekly-hours contract (default 8h/week). Log sessions as you work — same-day sessions are automatically added together — and see your current week's progress, days logged, and history of past weeks.

This version runs as a tiny Node/Express server in Docker, storing data in a JSON file on a **Docker volume**, so your hours persist across container restarts, rebuilds, and even `docker compose down` — not just for one browser session.

## Run it with Docker Desktop

1. Make sure Docker Desktop is open and running.
2. Open a terminal in this folder (the one with `docker-compose.yml`).
3. Start it:
   ```
   docker compose up -d --build
   ```
4. Open **http://localhost:8080** in your browser.

That's it — Docker Desktop will show a `timecard` container running, and a `timecard-data` volume holding your data.

To stop it: `docker compose stop`. To stop and remove the container (data is untouched, it lives in the volume): `docker compose down`. To start again later: `docker compose up -d`.

### Updating after you edit the code

```
docker compose up -d --build
```

This rebuilds the image and restarts the container. Your data is unaffected since it lives in the separate `timecard-data` volume, not in the container itself.

## Where your data lives

Entries are stored server-side in `/data/timecard.json` **inside the named Docker volume** `timecard-data`, not in the browser. That means:

- The same data shows up no matter which browser or device you use, as long as it points at this server.
- Restarting Docker Desktop, rebuilding the image, or restarting your machine does **not** lose data — only removing the volume itself would (`docker compose down -v`, which you won't run by accident since `-v` has to be explicit).

If you'd rather see the data file directly on your host machine (e.g. to back it up with your normal file backups, or peek at it in a text editor), swap the named volume for a bind mount in `docker-compose.yml`:

```yaml
    volumes:
      - ./data:/data
```

Then `./data/timecard.json` in this project folder holds everything, in plain JSON.

Either way, it's still worth using the in-app **Export backup** button occasionally (Contract & data → Export backup) — it downloads a JSON snapshot you can keep separately or use with **Import backup** to restore or move data.

## Accessing it from other devices on your network

By default `http://localhost:8080` only works on the machine running Docker Desktop. To reach it from your phone or another computer on the same network (or over something like Tailscale):

1. Find your machine's local/Tailscale IP (e.g. `192.168.1.23` or a `100.x.x.x` Tailscale address) — on Mac/Linux: `ifconfig | grep inet`; on Windows: `ipconfig`; Tailscale: `tailscale ip`.
2. Visit `http://<that-ip>:8080` from the other device.

## Requiring a login (optional)

By default there's no login — anyone who can reach the port can use it. That's reasonable on a trusted network (home LAN, Tailscale), but if you want a login anyway, or plan to expose this more broadly:

1. Copy the template: `cp .env.example .env`
2. Edit `.env` and set a username/password:
   ```
   AUTH_USER=yourname
   AUTH_PASS=something-not-guessable
   ```
3. Restart: `docker compose up -d`

Once both are set, every request — the page itself and the API — requires that username/password, using your browser's normal login prompt (HTTP Basic Auth). Leave `.env` unset (or delete it) to go back to no login. `docker compose logs timecard` shows whether auth is on at startup.

`.env` is gitignored and isn't copied into the image — credentials live only in your local compose environment, not baked into any image you build or share.

This is fine for personal use behind Tailscale/your LAN. If you ever expose the port directly to the public internet, note that Basic Auth alone sends credentials base64-encoded (not encrypted) — pair it with HTTPS via a reverse proxy (e.g. Caddy or nginx) in that case.

## How it works

- **Live shift**: press **Start shift** when you sit down to work. It shows a running stopwatch (HH:MM:SS), and you can **Pause**/**Resume** as you take breaks — paused time doesn't count. Press **End & log** when you're done and it adds a single entry for the day you started, with the total time and your note. **Discard** throws the shift away without logging anything (e.g. if you started it by mistake). The shift's state lives on the server, so refreshing the page — or even restarting the container — won't lose a running shift.
- **Log time**: pick a date, enter hours/minutes (or use the quick +15m/+30m/+1h/+2h chips to log against today instantly), optionally add a note, and add the entry. Multiple sessions on the same date are stored separately but summed automatically wherever a daily total is shown. The date field defaults to today but isn't locked — pick any past date to backfill a missed day.
- **This week's punch**: the header shows total hours logged this week against your weekly quota, with hours remaining (or over).
- **Day ledger**: browse days with logged time, expand a day to see and delete individual sessions. Toggle between "This week" and "All time".
- **Week history**: a small bar chart plus a table of your last several weeks, each flagged as over/under/on target.
- **Contract & data** (top-right button): change your weekly hour target or which day the week starts on, export a JSON backup, import a backup, or erase everything.

If the app can't reach the server (e.g. the container isn't running), a banner appears at the top. It retries automatically in the background and clears itself once the server responds — no need to refresh manually.

## Project layout

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server.js          # Express server + JSON-file storage + REST API
└── public/
    ├── index.html
    ├── style.css
    └── app.js          # frontend, talks to the server via fetch()
```

## API (for reference)

All endpoints are under `/api` and return the full `{ entries, settings }` state after any mutation.

| Method | Path              | Body                                      |
|--------|-------------------|--------------------------------------------|
| GET    | `/api/state`      | —                                          |
| POST   | `/api/entries`    | `{ date, hours, note? }`                   |
| DELETE | `/api/entries/:id`| —                                          |
| PUT    | `/api/settings`   | `{ weeklyTarget?, weekStart? }`            |
| POST   | `/api/import`     | `{ entries: [...], settings?: {...} }`     |
| POST   | `/api/clear`      | — (erases all entries)                     |
| GET    | `/api/export`     | — (downloads a full JSON backup)           |
| POST   | `/api/shift/start`| `{ date, note? }` (409 if one's already running) |
| POST   | `/api/shift/pause`| —                                           |
| POST   | `/api/shift/resume`| —                                          |
| POST   | `/api/shift/end`  | — (creates an entry from the elapsed time)  |
| POST   | `/api/shift/cancel`| — (discards without logging)               |

## Customizing

- Change the default weekly target/week-start in the app itself (Contract & data), or edit `DEFAULT_STATE` in `server.js`.
- Colors, type, and layout live in `public/style.css`.
- Change the exposed host port by editing the `"8080:3000"` line in `docker-compose.yml`.
- Require a login by setting `AUTH_USER`/`AUTH_PASS` in `.env` — see "Requiring a login" above.
