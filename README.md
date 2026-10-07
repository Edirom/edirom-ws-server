# edirom-ws-server

Lightweight WebSocket relay that lets multiple Edirom clients join a shared "session" and communicate with each other.

```
git clone --recurse-submodules https://github.com/Edirom/edirom-ws-server.git
cd edirom-ws-server
docker build -t edirom-ws-server .
docker run -d \
  -e PORT=3000 \
  -e DEBUG_TOKEN=change-me \
  -v /my/logs:/usr/src/app/data \
  -p 3000:3000 \
  edirom-ws-server
```

The server is now reachable at `ws://localhost:3000`

## Configuration

Set these as environment variables, or copy `.env.example` to `.env`.

| Variable | Purpose |
|---|---|
| `DEBUG_TOKEN` | Enables `GET /debug/sessions` (send it as the `X-Debug-Token` header). Unset = endpoint disabled. |
| `PORT` | Defaults to `3000`. |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error` or `silent`. `debug` adds raw message payloads and state changes. |
| `LOG_FORMAT` | `pretty` (default, human-readable) or `json` (one JSON object per line). |
| `MAX_CONNECTIONS` | Max simultaneously open WebSocket connections. Over the limit, new connections get HTTP `503`. Default `1000`. |
| `MAX_SESSIONS` | Max simultaneous sessions. Creating another one is answered with `error`/`serverFull`. Default `1000`. |
| `MAX_CLIENTS_PER_SESSION` | Max members per session. Joining a full session is answered with `error`/`sessionFull`. Default `100`. |
| `MESSAGE_RATE_PER_SEC` / `MESSAGE_BURST` | Per-connection token bucket: sustained messages per second / burst size. A client exceeding it is disconnected with close code `1008`. Defaults `40` / `80`. |

Client names are stripped of control characters and capped at 64 characters (device types: 32); messages larger than 64 KB are rejected. Unresponsive connections are dropped by a 30 s heartbeat. Every connection must send a `protocolVersion` matching the server's (see the wire protocol below); otherwise it is answered with `error`/`protocolMismatch` and closed.

## Observability

- `GET /debug/sessions` — live snapshot of in-memory sessions (members, device types, durations). Needs the `X-Debug-Token` header.

  ```
  curl -H "X-Debug-Token: <DEBUG_TOKEN>" http://localhost:3000/debug/sessions
  ```

- `GET /` — plain health check (`WebSocket server is running`).

- `data/sessions.log` gets one JSON line per session that ends — members, device types, durations, why it ended. Rotates at 20MB; old files are kept. Mount `data/` (see the example above) to persist it.

## Wire protocol

The wire protocol is defined in code, once, in [`ws-protocol.js`](https://github.com/Edirom/edirom-connected-workspace/blob/main/ws-protocol.js) inside the `edirom-connected-workspace` repo (vendored here as a git submodule at `vendor/edirom-connected-workspace`) — that file is the single source of truth for both this server and the canonical browser client. For a human-readable overview (message tables, when each one is sent), see [that repo's README, "Wire protocol" section](https://github.com/Edirom/edirom-connected-workspace#wire-protocol) Which state keys exist (`edition`, `work`, `connection`) is defined by `STATE_SCHEMA` in [`src/state.js`](src/state.js).

