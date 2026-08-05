# Clocker (self-hosted)

[![Latest release](https://img.shields.io/github/v/release/Iwe-Coumou/clocker)](https://github.com/Iwe-Coumou/clocker/releases/latest)

> **Note:** The idea, features, and design decisions here are mine; the code itself was written entirely by Claude (Anthropic's AI) from my instructions — I didn't hand-write any of it. It's a quick practical tool and it works, but treat it accordingly if you're evaluating it as a code sample or handing it off to someone else.

A small time tracker for logging hours against a weekly-hours contract (default 8h/week). Log sessions as you work — same-day sessions are automatically added together — and see your current week's progress, days logged, and history of past weeks and months. Hours carry between weeks: run long one week and the next week's goal drops to match, so being ahead or behind is one running number rather than something that resets.

This version runs as a tiny Node/Express server in Docker, storing data in a JSON file on a **Docker volume**, so your hours persist across container restarts, rebuilds, and even `docker compose down` — not just for one browser session.

## Run it with Docker Desktop

1. Make sure Docker Desktop is open and running.
2. Open a terminal in this folder (the one with `docker-compose.yml`).
3. Start it:
   ```
   docker compose up -d --build
   ```
4. Open **http://localhost:8090** in your browser.

That's it — Docker Desktop will show a `clocker` container running, and a `clocker-data` volume holding your data.

To stop it: `docker compose stop`. To stop and remove the container (data is untouched, it lives in the volume): `docker compose down`. To start again later: `docker compose up -d`.

### Updating after you edit the code

```
docker compose up -d --build
```

This rebuilds the image and restarts the container. Your data is unaffected since it lives in the separate `clocker-data` volume, not in the container itself.

## Where your data lives

Entries are stored server-side in `/data/clocker.json` **inside the named Docker volume** `clocker-data`, not in the browser. That means:

- The same data shows up no matter which browser or device you use, as long as it points at this server.
- Restarting Docker Desktop, rebuilding the image, or restarting your machine does **not** lose data — only removing the volume itself would (`docker compose down -v`, which you won't run by accident since `-v` has to be explicit).

If you'd rather see the data file directly on your host machine (e.g. to back it up with your normal file backups, or peek at it in a text editor), swap the named volume for a bind mount in `docker-compose.yml`:

```yaml
    volumes:
      - ./data:/data
```

Then `./data/clocker.json` in this project folder holds everything, in plain JSON.

Either way, it's still worth using the in-app **Export backup** button occasionally (Contract & data → Export backup) — it downloads a JSON snapshot you can keep separately or use with **Import backup** to restore or move data.

### Upgrading from the old "Timecard" name

The project used to be called Timecard, and stored its data in `/data/timecard.json`. If you're upgrading from a version that predates the rename, the server reads the old file automatically on first boot, writes the data to `/data/clocker.json`, and logs that it did so. The old file is left in place as a rollback — nothing to do by hand.

The one thing that isn't automatic is the **volume name**, since Docker can't rename a volume in place. If your compose file used `timecard-data`, copy the contents across once:

```bash
docker compose down
docker volume create clocker_clocker-data
docker run --rm -v clocker_timecard-data:/old -v clocker_clocker-data:/new alpine \
  sh -c 'cp -a /old/timecard.json /new/clocker.json && chown 1000:1000 /new/clocker.json'
docker compose up -d
```

Your old volume stays untouched, so you can roll back by pointing the compose file at it again.

## Accessing it from other devices on your network

By default `http://localhost:8090` only works on the machine running Docker Desktop. To reach it from your phone or another computer on the same network (or over something like Tailscale):

1. Find your machine's local/Tailscale IP (e.g. `192.168.1.23` or a `100.x.x.x` Tailscale address) — on Mac/Linux: `ifconfig | grep inet`; on Windows: `ipconfig`; Tailscale: `tailscale ip`.
2. Visit `http://<that-ip>:8090` from the other device.

## Requiring a login (optional)

By default there's no login — anyone who can reach the port can use it. That's reasonable on a trusted network (home LAN, Tailscale), but if you want a login anyway, or plan to expose this more broadly:

1. Copy the template: `cp .env.example .env`
2. Edit `.env` and set a username/password:
   ```
   AUTH_USER=yourname
   AUTH_PASS=something-not-guessable
   ```
3. Restart: `docker compose up -d`

Once both are set, every request — the page itself and the API — requires that username/password, using your browser's normal login prompt (HTTP Basic Auth). Leave `.env` unset (or delete it) to go back to no login. `docker compose logs clocker` shows whether auth is on at startup.

`.env` is gitignored and isn't copied into the image — credentials live only in your local compose environment, not baked into any image you build or share.

This is fine for personal use behind Tailscale/your LAN. If you ever expose the port directly to the public internet, note that Basic Auth alone sends credentials base64-encoded (not encrypted) — pair it with HTTPS via a reverse proxy (e.g. Caddy or nginx) in that case.

## How it works

- **Live shift**: press **Start shift** when you sit down to work. It shows a running stopwatch (HH:MM:SS), and you can **Pause**/**Resume** as you take breaks — paused time doesn't count. Press **End & log** when you're done and it adds a single entry for the day you started, with the total time and your note. **Discard** throws the shift away without logging anything (e.g. if you started it by mistake). The shift's state lives on the server, so refreshing the page — or even restarting the container — won't lose a running shift. While a shift runs, a line under the clock projects what the week's total *will* be once the shift is logged (already-banked hours plus live time), and a chime sounds the moment that projection crosses this week's goal — so you know you've hit overtime without watching the numbers. Turn the chime off in Contract & data; it's a per-device preference.
- **Log time**: pick a date, enter hours/minutes (or use the quick +15m/+30m/+1h/+2h chips to log against today instantly), optionally add a note, and add the entry. Multiple sessions on the same date are stored separately but summed automatically wherever a daily total is shown. The date field defaults to today but isn't locked — pick any past date to backfill a missed day.
- **This week's punch**: the header shows total hours logged this week against this week's goal, with hours remaining (or over), plus your running balance. When the goal has been moved by that balance, a line underneath says so — e.g. `8:00 contracted · 4:00 already banked ahead`.
- **Day ledger**: browse days with logged time, expand a day to see individual sessions. Sessions that came from the stopwatch also show when they ran and how long they were paused — e.g. `09:15 – 12:40 · paused 0:25`. Entries typed into the form have no measured span, so that line is simply absent rather than faked. Each session has an edit (✎) and delete (✕) button — editing opens the duration, date and note inline, so a mistyped entry or a stopwatch left running too long can be corrected without deleting and re-adding it. Changing the date moves the entry to that day (and drops the recorded times, since they'd then contradict the date beside them). Toggle between "This week" and "All time".
- **History**: a small bar chart plus a table, toggling between **Weeks** and **Months**. **Weeks** is the view that judges: each week's total against the goal it was actually held to, an `adjusted` badge on any week whose goal was moved by the carry, and the running balance underneath. **Months** makes no claim about over or under — no target, no colouring — just hours logged, days worked, and an average per week. See "The running balance" below.
- **Contract & data** (top-right button): change your weekly hour target or which day the week starts on, settle the running balance, export a JSON backup, import a backup, export a CSV sheet, or erase everything.

Two export formats, for two different jobs: **Export backup (.json)** is the one the import buttons read back, so use it to move or restore data. **Export sheet (.csv)** is a flat `date, hours, minutes, note, started_at, ended_at, paused_minutes, logged_at` table for a spreadsheet or an invoice — it can't be imported.

Importing a `.json` backup comes in two modes. **Import (replace)** swaps the whole ledger for the backup's contents — the restore/move path. **Import (merge)** adds the backup's entries to what's already on this server, skipping any it already has (matched by entry id), and leaves the target and week-start untouched. Merge is how you bring a second machine's hours home: run Clocker on a laptop while travelling, export when you're back, and merge that file into your main install. Because the match is by id, merging the same file twice adds nothing the second time.

### The running balance

The week is the contracted unit, and being ahead or behind it is one continuous fact about your hours. So **whatever a week banks above or below the contracted figure is handed to the next week as a carry.** Work 12 hours against an 8-hour contract and next week asks for 4. Work only 4 and next week asks for 12.

This runs on **indefinitely**. Nothing resets it automatically — a month boundary is just a calendar, and zeroing on one would delete hours you really worked. The current balance is in the header, and History → Weeks spells it out underneath the table.

A worked example, 8h/week:

| Week | Carried in | Goal | Logged | Balance after |
|---|---|---|---|---|
| 1 | 0:00 | 8:00 | 20:00 | +12:00 |
| 2 | +12:00 | 0:00 | 0:00 | +4:00 |
| 3 | +4:00 | 4:00 | 4:00 | 0:00 |
| 4 | 0:00 | 8:00 | 2:00 | −6:00 |
| 5 | −6:00 | 14:00 | 6:00 | −14:00 |

Week 2's goal is zero because week 1 already covered it; the surplus a zero can't absorb rolls on to week 3. Week 5 asks for 14:00 because weeks 4 and 5 both came up short.

The live shift measures against the **adjusted** goal too, so on a week trimmed to 4:00 the overtime chime sounds at the fourth hour, not the eighth.

**Settling up.** A balance that carries forever will, after a long enough gap, ask for a week you're never going to work. **Contract & data → Settle up** draws a line under everything up to the current week and starts the count from level. It's deliberate and confirmed, never automatic — nothing else in the app clears a balance. Your entries aren't touched; only the over/under count restarts, and weeks before the line show in History → Weeks as `settled`, with their hours but no verdict.

### What the Months view is for

Months are **descriptive only**: hours logged, days worked, and an average per week. No target, no balance, no over/under colouring.

That's deliberate. Any monthly target would be an artifact of how the weeks happen to fall rather than something your contract says, and inventing one invites a comparison that doesn't mean anything. The over/under signal lives on the weekly scale, where the contract actually is; Months just answers "how much did I work in August".

Two consequences worth knowing. A month here is the **plain calendar month** a day falls in, so a week straddling the boundary has its days split between two months — the weekly and monthly totals for a period can differ, by design. And the average per week for the month in progress is divided by the days that have actually elapsed, not the whole month, so a good first week doesn't read as a terrible month until the 30th.

### How durations are shown

**The minute is the unit.** It's what the forms accept, what the editor shows, and what every total is rendered in — so durations are snapped to a whole number of minutes on the way in, and a total never shows a minute that isn't in the data. Ending a stopwatch shift rounds it to the nearest minute; the seconds on the running clock are there to watch, not to bank.

Every duration in the UI is **H:MM** — `0:25`, `1:07`, `7:45`. Hours are stored internally as decimals (`0.41`), but decimal hours are hard to read at a glance and rounding them to something readable throws away real minutes: 25 minutes is not half an hour, and 5 minutes is not zero.

The one place decimals remain is the **CSV export**, where the `hours` column stays decimal so a spreadsheet can sum and multiply it directly. It's rounded to 2 places for readability, so sum the exact `minutes` column beside it if the pennies matter. `paused_minutes` is whole minutes for the same reason.

Entries logged by an older version sat on a finer 36-second grid, which made edits drift — adding one minute could move a weekly total by two. They're rounded to their nearest minute (at most a 30-second move each) the first time the server starts after this change, and the rounded values are written back to the data file.

If the app can't reach the server (e.g. the container isn't running), a banner appears at the top. It retries automatically in the background and clears itself once the server responds — no need to refresh manually.

## Project layout

```
.
├── Dockerfile
├── docker-compose.yml
├── docker-entrypoint.sh  # fixes data-volume ownership, then drops to the `node` user
├── package.json
├── package-lock.json     # pinned so `npm ci` rebuilds the same image every time
├── server.js             # Express server + JSON-file storage + REST API
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js            # frontend, talks to the server via fetch()
└── test/
    └── smoke.test.js     # end-to-end pass over the API
```

The container starts as root only long enough to `chown` the data volume, then runs the app as the unprivileged `node` user. A named volume only inherits ownership from the image when Docker creates it empty, so doing this at startup is what lets an existing install upgrade without a manual `chown`.

## Tests

There's one smoke test covering the endpoints that touch stored data — shifts, entry add/edit/delete, minute rounding, CSV escaping, concurrent writes, and survival across a restart. It boots the real server against a throwaway data file, so the persistence path is exercised for real.

```
npm install
npm test
```

No Docker needed. It's a safety net for edits to `server.js`, not exhaustive coverage.

## API (for reference)

All endpoints are under `/api` and return the full `{ entries, settings, activeShift }` state after any mutation.

Entries created by the stopwatch carry `startedAt`, `endedAt` and `pausedMs`; ones typed into the form don't. Paused time needs no separate tracking — it's whatever wall-clock time the shift spanned but didn't bank as worked time.

A running shift is reported as `{ date, note, running, elapsedMs, startedAt }`. It deliberately sends **elapsed duration rather than a start timestamp**: the browser stamps arrival with its own clock and ticks forward from there, so a phone whose clock is a few minutes off from the host still shows the correct stopwatch time.

| Method | Path              | Body                                      |
|--------|-------------------|--------------------------------------------|
| GET    | `/api/state`      | —                                          |
| POST   | `/api/entries`    | `{ date, hours, note? }`                   |
| PATCH  | `/api/entries/:id`| `{ date?, hours?, note? }` — omitted fields keep their current value |
| DELETE | `/api/entries/:id`| —                                          |
| PUT    | `/api/settings`   | `{ weeklyTarget?, weekStart?, balanceAnchor? }` |
| POST   | `/api/import`     | `{ entries: [...], settings?: {...} }`     |
| POST   | `/api/clear`      | — (erases all entries)                     |
| GET    | `/api/export`     | — (downloads a full JSON backup)           |
| GET    | `/api/export.csv` | — (downloads a flat CSV sheet)             |
| POST   | `/api/shift/start`| `{ date, note? }` (409 if one's already running) |
| POST   | `/api/shift/pause`| —                                           |
| POST   | `/api/shift/resume`| —                                          |
| POST   | `/api/shift/end`  | — (creates an entry from the elapsed time)  |
| POST   | `/api/shift/cancel`| — (discards without logging)               |

`balanceAnchor` is a `YYYY-MM-DD` week start, or `""` for "never settled". Settings are applied field by field — anything omitted or malformed keeps its current value, so a partial save can't clear a setting by accident.

## Publishing to Docker Hub

Local builds are single-architecture — building on an Intel/AMD machine produces an amd64-only image, which fails to start on a Raspberry Pi, a Synology, or an Apple Silicon Mac. Since that's a lot of the audience for a self-hosted tool, publish multi-arch:

```bash
docker login
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t icoumou/clocker:1.5.0 \
  -t icoumou/clocker:latest \
  --push .
```

Create the repository on Docker Hub first, or the push fails with a 404. The arm64 half builds under emulation, so expect it to take a few minutes.

Note that a multi-platform build **can't be stored locally** — Docker's image store holds one image per tag. `--push` sends it straight to the registry (the normal path); `--load` keeps it locally but only for a single platform. For day-to-day work keep using plain `docker compose up -d --build`, which builds only for your own machine and is much faster.

`.env` is excluded via `.dockerignore` and credentials are read from the environment at runtime, so no login details end up in a published image.

### Running a published image

Nothing from this repo is needed — not the Dockerfile, not a clone. One command:

```bash
docker run -d --name clocker \
  -p 8090:3000 \
  -v clocker-data:/data \
  --restart unless-stopped \
  icoumou/clocker:1.4.0
```

Then open **http://localhost:8090**. The `clocker-data` volume is created for you on that first run — there's nothing to set up beforehand.

**Give it that `-v` flag.** It's the one part that isn't optional in practice, and skipping it fails in a way that looks fine for weeks. Without it the app still runs, still writes `/data/clocker.json`, and still survives restarts and reboots — but that file lives in the container's own writable layer, and **`docker rm` destroys it**. Updating to a newer image is precisely a `docker rm` plus a fresh `docker run`, so the first update silently takes every logged hour with it.

An image can't solve this for you: a Dockerfile can only declare an *anonymous* volume, which Docker names as a random hash and never reattaches to the next container. The name is what lets a new container find the old ledger, and only the person running it can supply one.

If you've already been running without a volume, you don't have to lose anything — export first, then re-import into the properly mounted container:

1. **Contract & data → Export backup** in the running app.
2. `docker rm -f clocker`
3. Run the command above, with the `-v` flag this time.
4. **Contract & data → Import backup**, and pick the file from step 1.

That's also the manual path for moving a ledger between machines, since each host's volume is its own separate ledger.

#### Setting a login on a pulled image

There's no `.env` inside the image and nothing to edit — pass the credentials in when you create the container:

```bash
docker run -d --name clocker \
  -p 8090:3000 \
  -v clocker-data:/data \
  -e AUTH_USER=yourname -e AUTH_PASS=something-not-guessable \
  --restart unless-stopped \
  icoumou/clocker:1.4.0
```

Omit both `-e` flags to run with no login. Environment variables are fixed when the container is created, so changing them later means `docker rm -f clocker` and running it again — safe, since the data is in the volume rather than the container.

`--env-file ./clocker.env` works too, with one file of `KEY=value` lines. Note it isn't the same mechanism as Compose's `.env`: lines are passed to the container verbatim, so quoting a value (`AUTH_PASS="x"`) makes the quotes part of the password.

#### Or with Compose

Same thing, but the file remembers the settings for you — worth it for anything you intend to keep running:

```yaml
services:
  clocker:
    image: icoumou/clocker:1.4.0
    container_name: clocker
    ports:
      # Host side only — change 8090 if it's taken. The app always listens on
      # 3000 inside the container.
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

Save it as `docker-compose.yml` in an empty folder and run `docker compose up -d`. It works as-is with no login: the `:-` means "empty if unset". To turn auth on, put an `.env` file **next to that compose file** with `AUTH_USER=` / `AUTH_PASS=` lines — Compose reads it on your machine and substitutes the values in, so the credentials never go near the image.

Pin a version rather than `latest` — `latest` changes under people without warning.

#### A note on Docker Desktop's "Run" dialog

Pulling the image and hitting **Run** in the GUI works, but the dialog makes two of the four settings above easy to miss:

- **Host port** left blank gets you a random port, not 8090 — the app is running, just not where you're looking. The container port is 3000.
- **Volumes** left blank is the data-loss case described above. The Host path field is a bind-mount picker, so for a named volume run `docker volume create clocker-data` first, or just use the command line.
- There's no restart-policy field at all, so the container won't come back after a reboot.

Fine for a five-minute look; use the one-liner or Compose for anything you keep.

## Customizing

- Change the default weekly target/week-start in the app itself (Contract & data), or edit `DEFAULT_STATE` in `server.js`.
- Colors, type, and layout live in `public/style.css`.
- Change the exposed host port by setting `CLOCKER_PORT` in `.env` (e.g. `CLOCKER_PORT=9000`), then `docker compose up -d`. It defaults to 8090. Only the host side changes — the app always listens on 3000 inside the container, so a published image doesn't need rebuilding to move ports.
- Require a login by setting `AUTH_USER`/`AUTH_PASS` in `.env` — see "Requiring a login" above.

## Changelog

- **1.5.0** — **Running balance**: hours now carry between weeks. Go over one week and the next week's goal drops by the surplus; come up short and it rises. The balance runs on indefinitely — the header shows where you stand, and **Contract & data → Settle up** clears it when you decide the slate is clean. The history panel toggles between **Weeks** (each week against the goal it was held to, plus the balance) and **Months** (hours logged, days worked, average per week — descriptive only, no target). The overtime chime now fires at the adjusted goal.
- **1.4.0** — **Overtime chime**: while a shift runs, a line under the clock projects what the week's total will be once it's logged, and a chime sounds the moment that projection crosses your weekly target. Toggle it in Contract & data (a per-device preference).
- **1.3.0** — **Merge import**: bring a second machine's hours home without losing what's already here. Contract & data now offers Import (replace) and Import (merge) — merge adds the backup's entries and skips any already present (matched by entry id), so it's safe to repeat and won't touch your target or week-start. A version footer at the bottom of the page links to the source and image.
- **1.2.1** — Durations are stored as whole minutes rather than on a finer grid, fixing weekly totals that drifted when an entry was edited (a one-minute edit could move a total by two). Existing entries are rounded to the nearest minute on first start after upgrading. The CSV export gains an exact `minutes` column, between `hours` and `note`.
- **1.2.0** — Live shift stopwatch with pause/resume, day ledger with inline editing, week history chart, JSON/CSV export and import, optional HTTP Basic Auth, and the rename from Timecard (with automatic data migration).
