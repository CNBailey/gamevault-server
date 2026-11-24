# GameVault

A self-hosted catalogue for PlayStation game dumps, served as a web page from your NAS. It works like Ember Media Manager does for movies.

- Scans **PS5 `.exfat` game images**, **PS4 `.pkg`** files (base game + updates + DLC grouped per folder) and unpacked PS4/PS5 folder dumps
- Reads title, title ID, content ID and version straight from the dumps (including from inside `.exfat` images, without mounting them), plus their own icon
- Looks every game up on **IGDB**: poster, backdrop, screenshots, trailer, summary, release year, genres, developer and publisher, critic and user scores
- Library page with PS5/PS4 filter, categories, title search, favourites and sorting
- Details page with the scraped info plus size, file count, dates and path
- **REST API** (`/api/v1`) for everything, including file listing and HTTP Range downloads, ready for a PS5 client app
- One Docker container; runs on Synology, or any Linux box with Docker (amd64 and arm64)

Game folders are mounted **read-only**: GameVault never changes your dumps. Its database and artwork live in `/data`.

## Install on a Synology

1. In **Package Center**, install **Container Manager**.
2. In **File Station**, create the folder `docker/gamevault`.
3. In **Container Manager → Project → Create**: name it `gamevault`, choose the path `/volume1/docker/gamevault`, pick **Create docker-compose.yml**, and paste in [`docker-compose.yml`](docker-compose.yml). Change the game paths if your share isn't `/volume1/Games`.
4. Open `http://<nas-ip>:8686`, then go to **Settings → Metadata & media** and enter your IGDB client ID and secret (see below). Click **Scan & refresh all details**.

To update: **Container Manager → Project → gamevault → Action → Build** (it pulls the newest image).

### Getting IGDB credentials (free)
1. Sign in at <https://dev.twitch.tv/console> (a Twitch account is needed; turn on two-factor authentication if asked).
2. **Register Your Application**: any name, OAuth redirect URL `http://localhost`, category *Application Integration*, client type *Confidential*.
3. Copy the **Client ID**, then **New Secret** → copy the secret. Paste both into GameVault's Settings page.

## How games are found

Each library folder is searched up to 4 levels deep. A game is:

| On disk | Detected as |
|---|---|
| `PPSA12345-Name (v01.000.000).exfat` (+ optional `.exfat.ps5-archive.json`) | PS5 exFAT image; details read from `sce_sys/param.json` inside the image, then the JSON beside it, then the file name |
| `Some Game/sce_sys/param.json` | PS5 folder dump |
| `Some Game/sce_sys/param.sfo` | PS4 folder dump |
| `Some Game/*.pkg` (any `.pkg` up to 2 levels inside) | PS4 PKG game; the base game, updates and DLC are grouped together |
| `Some Game.pkg` loose in the library folder | PS4 PKG game |

Synology's `@eaDir` and `#recycle` folders are ignored. If a game disappears from disk it is flagged rather than deleted, so its favourite survives; **Settings → Needs review** lets you clean these up.

Matching uses the title inside the dump, falling back to the folder name. Uncertain matches appear under **Needs review**. **Fix match** on any game lets you search IGDB yourself.

## API

Base URL: `http://<nas-ip>:8686/api/v1`. All responses are JSON unless noted.

| Method & path | What it does |
|---|---|
| `GET /health` | Version and game count |
| `GET /games?platform=PS5&genre=RPG&q=astro&fav=1&sort=added\|title\|year\|rating\|size` | List games |
| `GET /games/{id}` | Full details |
| `PUT /games/{id}/favourite` `{"favourite": true}` | Set favourite (no body = toggle) |
| `GET /games/{id}/files` | Files making up the game, with sizes and download URLs |
| `GET /games/{id}/files/{path}` | Download a file; supports `Range` for resumable and parallel downloads |
| `POST /games/{id}/rescrape` | Look the game up again |
| `GET /games/{id}/candidates?q=` · `POST /games/{id}/match` `{"igdbId": 123}` | Manual matching |
| `GET /genres` | Categories with counts |
| `GET /scan` · `POST /scan` `{"libraryId"?, "rescrapeAll"?}` | Scan status / start a scan |
| `GET/POST/PATCH/DELETE /libraries` | Library folders |
| `GET /review` | Games needing a manual check |
| `GET/PUT /settings` | IGDB credentials, scan interval |

`titleId`, `contentId` and `version` are returned for every game so a console client can tell whether a game is already installed, or older than the copy on the NAS.

> The API has no login. Keep the port on your home network; don't forward it to the internet.

## Configuration

| Variable | Default | |
|---|---|---|
| `GV_LIBRARIES` | — | `path=PS5,path=PS4` folders to scan (more can be added in Settings) |
| `GV_PORT` | `8686` | |
| `GV_DATA_DIR` | `/data` | Database and artwork |
| `GV_SCAN_INTERVAL_HOURS` | `6` | `0` turns automatic scans off |
| `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` | — | Optional; can be set in Settings instead |

## Development

Needs Node 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install && npm --prefix web install
npm run fixtures                      # fake PS4/PS5 dumps in ./.fixtures
GV_LIBRARIES="$PWD/.fixtures/PS5=PS5,$PWD/.fixtures/PS4=PS4" npm run dev
npm --prefix web run dev              # UI with hot reload on :5173 (proxies to :8686)
npm test
```

Every push to `main` runs the tests and publishes `ghcr.io/cnbailey/gamevault-server:latest` for amd64 and arm64.
