const WebSocket = require('ws');
const { createClient, sanitizeLabel } = require('./client');
const { adoptSessionState } = require('./state');
const broadcast = require('./broadcast');
const sessionLogger = require('./session-logger');
const { DEFAULT_LIMITS, MAX_CLIENT_NAME_LENGTH, MAX_DEVICE_TYPE_LENGTH } = require('./limits');
const { createTokenBucket } = require('./rate-limit');

// Answers a request that is refused *before* the WebSocket handshake with a
// bare HTTP status and closes the connection. end() (not write()+destroy())
// so the response is flushed before the socket goes away.
function refuseUpgrade(socket, statusLine) {
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// Handles HTTP upgrade requests, turning each one into a client joining
// (or creating) a session, then wires that connection's message/close events.
function createUpgradeHandler({ wss, sessionStore, messageRouter, protocol, limits = DEFAULT_LIMITS }) {
    return function handleUpgrade(request, socket, head) {
        console.log("New connection!");
        // Cheap insurance: every path below this point until wss.handleUpgrade()
        // takes over is currently synchronous, but a socket-level 'error' with no
        // listener would crash the process, so cover it unconditionally.
        socket.on('error', (err) => console.error('raw socket error during upgrade:', err));

        // request.url is attacker-controlled and new URL() throws on some
        // syntactically valid request targets (e.g. "//"). An exception here
        // would reach the process-level uncaughtException handler and take the
        // whole server — and every session — down, so refuse instead.
        let url;
        try {
            url = new URL(request.url, 'http://localhost');
        } catch (err) {
            console.warn(`Refusing upgrade with unparseable request URL ${JSON.stringify(String(request.url).slice(0, 100))}.`);
            refuseUpgrade(socket, '400 Bad Request');
            return;
        }

        // Checked before the handshake so an overloaded server spends as little
        // as possible on each refused connection. Applies to pings as well.
        if (wss.clients.size >= limits.maxConnections) {
            console.warn(`Connection limit (${limits.maxConnections}) reached. Refusing new connection.`);
            refuseUpgrade(socket, '503 Service Unavailable');
            return;
        }

        const isPing = url.searchParams.get(protocol.CONNECT_PARAMS.ping) === 'true';
        const protocolCompatible = url.searchParams.get(protocol.CONNECT_PARAMS.protocolVersion) === String(protocol.PROTOCOL_VERSION);
        const requestedSessionId = url.searchParams.get(protocol.CONNECT_PARAMS.sessionId)?.toUpperCase() ?? null;

        let client = null;
        let sessionId = null;

        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.on('error', (err) => console.error(`ws error (session ${sessionId ?? 'pending'}, client ${client?.id ?? 'none'}):`, err));

            // Sent as a WebSocket message (not an HTTP 4xx) because a browser page
            // cannot read why an upgrade was refused, so it couldn't tell the user.
            // Sent for pings too, so the availability check already reveals an
            // incompatible server before anyone tries to join.
            const rejectWith = (reason, details) => {
                broadcast.safeSend(ws, protocol.build('error', { reason, ...details }));
                ws.close();
            };

            if (!protocolCompatible) {
                console.warn(`Refusing client with incompatible protocol version "${url.searchParams.get(protocol.CONNECT_PARAMS.protocolVersion)}" (server: ${protocol.PROTOCOL_VERSION}).`);
                rejectWith(protocol.ERROR_REASONS.protocolMismatch, { serverVersion: protocol.PROTOCOL_VERSION });
                return;
            }

            if (isPing) {
                // Lightweight availability check: confirms the WebSocket upgrade path
                // works without creating or touching any session.
                ws.send(JSON.stringify(protocol.build('pong')));
                ws.close();
                return;
            }

            client = createClient({
                name: sanitizeLabel(url.searchParams.get(protocol.CONNECT_PARAMS.clientName), MAX_CLIENT_NAME_LENGTH),
                deviceType: sanitizeLabel(url.searchParams.get(protocol.CONNECT_PARAMS.deviceType), MAX_DEVICE_TYPE_LENGTH)
            });
            client.ws = ws;
            // Heartbeat bookkeeping: 'pong' is the protocol-level control frame
            // ws replies with automatically when we .ping() it below — distinct
            // from the application-level {response:'pong'} JSON message sent on
            // the ?ping=true short path above.
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });

            if (requestedSessionId === null) {
                // No session ID provided → create a new session
                if (sessionStore.count() >= limits.maxSessions) {
                    console.warn(`Session limit (${limits.maxSessions}) reached. Refusing to create a new session.`);
                    rejectWith(protocol.ERROR_REASONS.serverFull);
                    return;
                }
                sessionId = sessionStore.create(client);
                const sessionData = sessionStore.getSessionData(sessionId);
                // The creator keeps the default state and reports its real state itself.
                broadcast.safeSend(ws, protocol.build('sessionJoined', { sessionId, clientId: client.id, sessionData }));

            } else if (sessionStore.get(requestedSessionId)) {
                // Session ID found → join the existing session
                if (sessionStore.get(requestedSessionId).clients.length >= limits.maxClientsPerSession) {
                    console.warn(`Session ${requestedSessionId} is full (${limits.maxClientsPerSession} clients). Refusing join.`);
                    rejectWith(protocol.ERROR_REASONS.sessionFull);
                    return;
                }
                sessionId = requestedSessionId;
                const initialSyncPatch = adoptSessionState(client, sessionStore.get(sessionId).clients);
                sessionStore.addClient(sessionId, client);
                const sessionData = sessionStore.getSessionData(sessionId);
                broadcast.safeSend(ws, protocol.build('sessionJoined', { sessionId, clientId: client.id, sessionData }));
                // Always sent (even with an empty patch): tells the joiner its initial state is complete.
                broadcast.safeSend(ws, protocol.build('syncState', { patch: initialSyncPatch }));
                // Notify the other clients in the session
                const clientData = { id: client.id, metadata: client.metadata };
                broadcast.broadcastToSession(sessionStore.get(sessionId), protocol.build('clientConnected', { clientData, sessionData }), ws);

            } else {
                // Session ID not found → send error and close
                console.log(`Session ${requestedSessionId} not found. Closing connection.`);
                rejectWith(protocol.ERROR_REASONS.sessionNotFound);
                return;
            }

            // One bucket per socket: a client may burst, but can't sustain more
            // than the configured rate. Checked before anything else touches the
            // message, so a flood costs as little as possible.
            const bucket = createTokenBucket({ ratePerSec: limits.messageRatePerSec, burst: limits.messageBurst });
            let rateLimited = false;

            ws.on('message', (message) => {
                if (rateLimited) return;
                if (!bucket.take()) {
                    rateLimited = true;
                    console.warn(`Message rate limit exceeded (session ${sessionId}, client ${client.id}). Closing connection.`);
                    // 1008 = policy violation
                    ws.close(1008, 'rate limit exceeded');
                    return;
                }
                console.log(`Received message: ${message}`);
                let messageJson;
                try {
                    messageJson = JSON.parse(message);
                } catch (e) {
                    console.error('Could not parse message:', e);
                    return;
                }
                if (!sessionId || !sessionStore.get(sessionId)) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.close();
                    }
                    return;
                }
                try {
                    messageRouter.handleMessage({ client, sessionId, ws }, messageJson);
                } catch (err) {
                    console.error(`message-router: unhandled error for session ${sessionId}, client ${client.id}:`, err);
                }
            });

            ws.on('close', () => {
                console.log("Connection closed!");
                if (!sessionId || !sessionStore.get(sessionId)) return;
                const summary = sessionStore.removeClient(ws, sessionId);
                if (summary) {
                    sessionLogger.logSessionTerminated(summary);
                    return;
                }
                const remainingSession = sessionStore.get(sessionId);
                const clientData = { id: client.id, metadata: client.metadata };
                const sessionData = sessionStore.getSessionData(sessionId);
                broadcast.broadcastToSession(remainingSession, protocol.build('clientDisconnected', { clientData, sessionData }), ws);
            });
        });
    };
}

module.exports = { createUpgradeHandler };
