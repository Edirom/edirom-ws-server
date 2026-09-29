# edirom-ws-server

Lightweight WebSocket relay that lets multiple Edirom clients join a shared "session" and stay in sync (which edition/work/connection each one is showing).

## Running

```
git submodule update --init   # required once, before npm install / docker build — see "Wire protocol" below
npm install
npm start        # or: node server.js
npm test         # unit + integration tests (node:test)
```

`PORT` defaults to `3000`.

## Architecture

```
server.js                 entry point: boots the HTTP+WS server
src/
  app.js                   wires express + http + ws together, exposes createServer()
  load-ws-protocol.js       loads the shared protocol module (see below)
  connection.js             handles WebSocket upgrade requests, wires message/close listeners
  message-router.js         dispatches incoming client messages to handlers
  session-store.js          in-memory session/client storage
  state.js                  per-client state schema, validation and sync logic (pure, no ws access)
  client.js                 client object factory
  broadcast.js              safe-send / broadcast-to-session helpers
vendor/
  edirom-connected-workspace/   git submodule — the canonical client; only ws-protocol.js in here is actually used
```

## Wire protocol

The wire protocol is defined in code, once, in [`ws-protocol.js`](https://github.com/Edirom/edirom-connected-workspace/blob/main/ws-protocol.js) inside the `edirom-connected-workspace` repo (vendored here as a git submodule at `vendor/edirom-connected-workspace`) — that file is the single source of truth for both this server and the canonical browser client, so there is no separate hand-written spec to keep in sync here anymore. For a human-readable overview (message tables, when each one is sent), see [that repo's README, "Wire protocol" section](https://github.com/Edirom/edirom-connected-workspace#wire-protocol) — it's documented there rather than here since `ws-protocol.js` lives there.

- `MESSAGES_TO_CLIENT` / `MESSAGES_TO_SERVER` catalog every message shape by direction (which field — `response`, `type`, or `message` — carries the discriminator, and how to build it).
- `CONNECT_PARAMS` + `buildConnectUrl`/`buildPingUrl` cover the WebSocket upgrade URL's query parameters (`ping`, `sessionId`, `clientName`, `deviceType`).
- `ERROR_REASONS` covers the `reason` values sent with an `error` message.

This server loads it at startup via `src/load-ws-protocol.js` (a dynamic `import()`, since the protocol module is a real ES module and this server is CommonJS). **This is why `git submodule update --init` (or cloning with `--recurse-submodules`) is required** before the server will start — without it, `vendor/edirom-connected-workspace/` is an empty directory and startup fails with a clear error pointing at this requirement.
