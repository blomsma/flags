# Remote API

The server exposes a small REST API for Pixera, Stream Deck and other show-control systems. JSON responses use the same state shape as the WebSocket client.

`GET /api/v1/health` checks availability. `GET /api/v1/state` returns settings and current motion. `GET /api/v1/settings` returns normalized settings.

Mutating requests require `Authorization: Bearer $API_TOKEN` when `API_TOKEN` is configured (the `X-API-Token` header is also accepted).

```sh
curl http://localhost:4174/api/v1/hoist/up -X POST   # also /api/v1/flags/up; returns 202
curl http://localhost:4174/api/v1/hoist/down -X POST # also /api/v1/flags/down; returns 202
curl http://localhost:4174/api/v1/settings -X POST -H 'Content-Type: application/json' \
  -d '{"windStartPercent":75,"windStrength":0.7,"mastSpacing":4.5}'
curl http://localhost:4174/api/v1/background -X POST -H 'Content-Type: image/png' --data-binary @background.png
curl http://localhost:4174/api/v1/flags -X POST -H 'Content-Type: image/png' -H 'X-Flag-Name: Canada' --data-binary @canada.png
curl http://localhost:4174/api/v1/flags/flag-id -X PATCH -H 'Content-Type: image/png' --data-binary @new-canada.png
```

`POST /api/v1/settings` accepts a partial patch and deep-merges `pole`, `lighting` and `background` with the current settings. Image uploads require valid magic bytes (PNG, JPEG or WebP); background video uploads use their declared MIME type. `PATCH /api/v1/flags/:id` replaces an existing custom flag image without changing its id or name.

Each slot may include `xOffset` (metres, -30 to 30). The global `mastSpacing` is applied first, then the per-mast offset. `meshResolution` accepts `standard`, `high`, or `ultra`; higher values add cloth subdivisions and GPU cost.

`POST /api/v1/execute` accepts `{ "settings": { ... }, "executeId": "show-1" }` and remains compatible with the existing execute command. The WebSocket endpoint `/ws` accepts `{"type":"hoist","direction":"up"|"down"}` and settings updates.
