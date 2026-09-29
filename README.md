# edirom-ws-server

Lightweight WebSocket relay that lets multiple Edirom clients join a shared "session" and communicate with each other.

## Running

```
docker build -t edirom-ws-server .
docker run \
  --env-file .env \
  -v /my/directory/:/usr/src/app/data \
  -p 3000:3000 \
  edirom-ws-server
```

## Configuration

Copy `.env.example` to `.env`.

| Variable | Purpose |
|---|---|
| `DEBUG_TOKEN` | Enables `GET /debug/sessions` (send it as the `X-Debug-Token` header). Unset = endpoint disabled. |
| `PORT` | Defaults to `3000`. |

## Observability

- `GET /debug/sessions` — live snapshot of in-memory sessions (members, device types, durations). Needs the `X-Debug-Token` header.

  ```
  curl -H "X-Debug-Token: <DEBUG_TOKEN>" http://localhost:3000/debug/sessions
  ```

- `data/sessions.log` gets one JSON line per session that ends — members, device types, durations, why it ended. Rotates at 20MB; old files are kept. Mount `data/` (see Docker below) to persist it.


## Wire protocol

The wire protocol is defined in code, once, in [`ws-protocol.js`](https://github.com/Edirom/edirom-connected-workspace/blob/main/ws-protocol.js) inside the `edirom-connected-workspace` repo (vendored here as a git submodule at `vendor/edirom-connected-workspace`) — that file is the single source of truth for both this server and the canonical browser client, so there is no separate hand-written spec to keep in sync here anymore. For a human-readable overview (message tables, when each one is sent), see [that repo's README, "Wire protocol" section](https://github.com/Edirom/edirom-connected-workspace#wire-protocol) — it's documented there rather than here since `ws-protocol.js` lives there.

