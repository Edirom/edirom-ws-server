# edirom-ws-server

Lightweight WebSocket relay that lets multiple Edirom clients join a shared "session" and stay in sync (which edition/work/connection each one is showing).

## Running

```
npm install
npm start        # or: node server.js
npm test         # unit + integration tests (node:test)
```

`PORT` defaults to `3000`.

## Architecture

```
server.js               entry point: boots the HTTP+WS server
src/
  app.js                 wires express + http + ws together, exposes createServer()
  connection.js           handles WebSocket upgrade requests, wires message/close listeners
  message-router.js       dispatches incoming client messages to handlers
  session-store.js        in-memory session/client storage
  state.js                per-client state schema, validation and sync logic (pure, no ws access)
  client.js               client object factory
  broadcast.js            safe-send / broadcast-to-session helpers
```

## Wire protocol

This is the closest thing to a spec the protocol currently has — no shared schema exists between this server and its client repos (see "Known gaps" below), so treat this document as the source of truth and keep it in sync with `src/message-router.js` and `src/connection.js`.

### Connecting

Clients connect via a WebSocket upgrade to `/` with query parameters:

| param | purpose |
|---|---|
| `ping` | `true` → lightweight health check; server replies `{response:'pong'}` and closes. No session is touched. |
| `sessionId` | join an existing session (case-insensitive, 6-character code). Omit to create a new session. |
| `clientName` | display name for this client (truncated to 64 chars). |
| `deviceType` | free-form device label (truncated to 32 chars). |

### Server → client messages

| shape | when |
|---|---|
| `{ response: 'sessionJoined', sessionId, clientId, sessionData }` | sent to a client right after it creates or joins a session |
| `{ response: 'clientConnected', clientData, sessionData }` | sent to existing members when someone joins |
| `{ response: 'clientDisconnected', clientData, sessionData }` | sent to remaining members when someone leaves |
| `{ response: 'sessionDataUpdated', sessionData }` | sent to other members after a client renames itself |
| `{ response: 'clientRemoved' }` | sent to a client that another member kicked, right before the server closes its socket |
| `{ response: 'sessionDissolved' }` | sent to every member when the session is dissolved, right before the server closes their sockets |
| `{ response: 'error', reason: 'sessionNotFound' }` | sent, then the socket is closed, when `sessionId` doesn't match a live session |
| `{ response: 'pong' }` | reply to a `ping=true` health check |
| `{ type: 'syncState', payload: { patch } }` | pushes a shared-state change (`edition`/`work`/`connection`) to a client. Always sent once to a joiner (possibly with an empty `patch`) so it knows its initial state is settled. |

`sessionData` is always `{ sessionMembers: [{ id, metadata: { name, deviceType } }, ...] }`.
`clientData` is always `{ id, metadata: { name, deviceType } }`.

### Client → server messages

| shape | effect |
|---|---|
| `{ message: 'updateClientName', clientName }` | renames this client; other members get `sessionDataUpdated` |
| `{ message: 'removeClient', clientId }` | kicks the named client from the session |
| `{ message: 'dissolveSession' }` | ends the session for everyone |
| `{ type: 'updateState', payload: { patch, cause? } }` | reports a state change. `cause: 'syncResult'` marks a client reporting what it actually applied after a `syncState` push — the server stores it but never fans it back out, so a failed apply can't bounce between clients. Any other/absent `cause` is treated as a user-driven change and is pushed to other members as `syncState`. |

Unknown `message`/`type` values are ignored (a warning is logged server-side for an unrecognized `type`).

## Known gaps

- No shared protocol definition exists between this server and its client repos — each side hand-maintains the same field names independently. A shared protocol module, distributed as a git submodule the same way `edirom-core-web-components` already is, is a planned follow-up; this document is the spec to extract it from.
