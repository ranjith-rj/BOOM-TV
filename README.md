# BOOM TV Player

A modern IPTV web player. **Flask** serves the API, **HTML/CSS/JavaScript** (with [hls.js](https://github.com/video-dev/hls.js)) is the frontend.

- App URL: <http://localhost:8787>
- Playlist source: `http://192.168.1.7:5350/playlist.m3u`

## Project structure

```
GTV_Python_VSCode/
├── app.py                  Flask backend (playlist fetch/parse/cache, API, stream proxy)
├── requirements.txt
├── README.md
├── templates/
│   └── index.html          Main page
├── static/
│   ├── css/style.css
│   ├── js/app.js           Channel UI + HLS player logic
│   └── images/logo.svg
└── .vscode/
    ├── launch.json         F5 to run/debug in VS Code
    └── settings.json
```

## Installation (Windows + VS Code)

Requires Python 3.10 or newer.

1. Open the `GTV_Python_VSCode` folder in VS Code (**File → Open Folder**).
2. Open a terminal (**Terminal → New Terminal**) and run:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

If PowerShell blocks activation, run this once and retry:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

3. Open <http://localhost:8787>.

You can also press **F5** in VS Code (select the `.venv` interpreter first via
**Ctrl+Shift+P → Python: Select Interpreter**).

macOS / Linux: `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python app.py`

## Configuration

Nothing is hardcoded in the channel data; everything comes from the playlist.
Defaults can be overridden with environment variables:

| Variable           | Default                                | Meaning                          |
|--------------------|----------------------------------------|----------------------------------|
| `GTV_PLAYLIST_URL` | `http://192.168.1.7:5350/playlist.m3u` | M3U playlist URL                 |
| `GTV_HOST`         | `127.0.0.1`                            | Bind address (`0.0.0.0` = LAN)   |
| `GTV_PORT`         | `8787`                                 | Port                             |
| `GTV_CACHE_TTL`    | `300`                                  | Playlist cache lifetime (s)      |
| `GTV_TIMEOUT`      | `15`                                   | Read timeout for IPTV server (s) |
| `GTV_DEBUG`        | `0`                                    | `1` = Flask debug + reloader     |

PowerShell example:

```powershell
$env:GTV_PLAYLIST_URL = "http://192.168.1.7:5350/playlist.m3u"
python app.py
```

## API

| Endpoint                 | Description                                                        |
|--------------------------|--------------------------------------------------------------------|
| `GET /`                  | Main application                                                   |
| `GET /api/channels`      | Parsed channels + categories (`?refresh=1` forces a re-download)   |
| `GET /api/playlist`      | Raw M3U playlist                                                   |
| `GET /api/health`        | Server status (`?deep=1` also probes the IPTV server)              |
| `GET /api/stream?url=…`  | Same-origin stream proxy (only hosts found in the playlist)        |

Errors from the IPTV server are returned as `502` with `{"ok": false, "error": "..."}`.
If a refresh fails but a previous playlist is cached, the cached list is served with `"stale": true`.

## Using the player

- Click a channel to play; use search and the category filter to narrow the list.
- Shortcuts: **Space** play/pause, **↑ / ↓** previous/next channel, **M** mute, **F** fullscreen.
- The channel list auto-refreshes every 5 minutes; **Refresh** forces it.
- The player reconnects automatically on network errors (3 attempts), recovers from media errors,
  and then falls back to the server proxy.

## Troubleshooting

- **"Cannot reach the IPTV server"** – check the playlist URL opens in your browser, and that the PC is
  on the same network as `192.168.1.7`.
- **Channels load but video won't play** – turn on **Use proxy** (top right). This fixes CORS problems, which
  are the most common cause with local IPTV servers.
- **Black screen / "format browsers don't support"** – browsers only play HLS (`.m3u8`) and MP4. Raw MPEG-TS
  (`.ts`), RTMP and UDP streams can't play in an HTML5 player; use an HLS output from your IPTV server.
- **Offline use** – hls.js loads from a CDN. For fully offline use, download
  `https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js` and save it as `static/js/hls.min.js`
  (the page falls back to it automatically).
