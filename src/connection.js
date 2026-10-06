const WebSocket = require('ws');
const { createClient, sanitizeLabel } = require('./client');
const { adoptSessionState } = require('./state');
const broadcast = require('./broadcast');
const sessionLogger = require('./session-logger');
const { DEFAULT_LIMITS, MAX_CLIENT_NAME_LENGTH, MAX_DEVICE_TYPE_LENGTH } = require('./limits');
const { createTokenBucket } = require('./rate-limit');
const defaultLog = require('./logger');
const { createActivityLog, describeClient, formatDuration, plural } = require('./activity-log');

// Close codes that mean "the client went away on purpose" (1000 normal, 1001
// going away, 1005 no status given). Anything else is worth a note in the log.
const ORDINARY_CLOSE_CODES = new Set([1000, 1001, 1005]);

function describeClose(code) {
    if (ORDINARY_CLOSE_CODES.has(code)) return '';
    if (code === 1006) return ' (connection lost)';
    if (code === 1008) return ' (rate limit exceeded)';
    return ` (close code ${code})`;
}

// Client-supplied text in a log line: bounded and quoted, so it can't flood
// the log or forge a second line.
const quoteForLog = (value) => JSON.stringify(String(value).slice(0, 100));

// Answers a request that is refused *before* the WebSocket handshake with a
// bare HTTP status and closes the connection. end() (not write()+destroy())
// so the response is flushed before the socket goes away.
function refuseUpgrade(socket, statusLine) {
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// Handles HTTP upgrade requests, turning each one into a client joining
// (or creating) a session, then wires that connection's message/close events.
function createUpgradeHandler({ wss, sessionStore, messageRouter, protocol, limits = DEFAULT_LIMITS, log = defaultLog, activity = createActivityLog({ sessionStore, log }) }) {
    return function handleUpgrade(request, socket, head) {
        // Cheap insurance: every path below this point until wss.handleUpgrade()
        // takes over is currently synchronous, but a socket-level 'error' with no
        // listener would crash the process, so cover it unconditionally.
        socket.on('error', (err) => log.warn(`Socket error during upgrade: ${err.message}`, { err }));

        // request.url is attacker-controlled and new URL() throws on some
        // syntactically valid request targets (e.g. "//"). An exception here
        // would reach the process-level uncaughtException handler and take the
        // whole server — and every session — down, so refuse instead.
        let url;
        try {
            url = new URL(request.url, 'http://localhost');
        } catch (err) {
            log.warn(`Refused upgrade: unparseable request URL ${quoteForLog(request.url)}`, { url: String(request.url).slice(0, 100) }, { throttle: 'bad-url' });
            refuseUpgrade(socket, '400 Bad Request');
            return;
        }

        // Checked before the handshake so an overloaded server spends as little
        // as possible on each refused connection. Applies to pings as well.
        if (wss.clients.size >= limits.maxConnections) {
            log.warn(`Refused connection: limit of ${limits.maxConnections} connections reached`, { limit: limits.maxConnections }, { throttle: 'connection-limit' });
            refuseUpgrade(socket, '503 Service Unavailable');
            return;
        }

        const isPing = url.searchParams.get(protocol.CONNECT_PARAMS.ping) === 'true';
        const protocolCompatible = url.searchParams.get(protocol.CONNECT_PARAMS.protocolVersion) === String(protocol.PROTOCOL_VERSION);
        const requestedSessionId = url.searchParams.get(protocol.CONNECT_PARAMS.sessionId)?.toUpperCase() ?? null;

        let client = null;
        let sessionId = null;

        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.on('error', (err) => log.warn(`WebSocket error (${client ? describeClient(client) : 'no client yet'}, session ${sessionId ?? 'none'}): ${err.message}`, { err, sessionId, clientId: client?.id }));

            // Sent as a WebSocket message (not an HTTP 4xx) because a browser page
            // cannot read why an upgrade was refused, so it couldn't tell the user.
            // Sent for pings too, so the availability check already reveals an
            // incompatible server before anyone tries to join.
            const rejectWith = (reason, details) => {
                broadcast.safeSend(ws, protocol.build('error', { reason, ...details }));
                ws.close();
            };

            if (!protocolCompatible) {
                log.warn(
                    `Refused client: protocol version ${quoteForLog(url.searchParams.get(protocol.CONNECT_PARAMS.protocolVersion))} does not match server version ${protocol.PROTOCOL_VERSION}`,
                    { serverVersion: protocol.PROTOCOL_VERSION },
                    { throttle: 'protocol-mismatch' }
                );
                rejectWith(protocol.ERROR_REASONS.protocolMismatch, { serverVersion: protocol.PROTOCOL_VERSION });
                return;
            }

            if (isPing) {
                // Lightweight availability check: confirms the WebSocket upgrade path
                // works without creating or touching any session. Debug-level:
                // monitors can ping every few seconds.
                log.debug('Answered availability ping');
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
                    log.warn(`Refused ${describeClient(client)}: limit of ${limits.maxSessions} sessions reached`, { limit: limits.maxSessions }, { throttle: 'session-limit' });
                    rejectWith(protocol.ERROR_REASONS.serverFull);
                    return;
                }
                sessionId = sessionStore.create(client);
                activity.event(`${describeClient(client)} created session ${sessionId}`, {
                    event: 'session_created', sessionId, clientId: client.id, name: client.metadata.name, deviceType: client.metadata.deviceType
                });
                const sessionData = sessionStore.getSessionData(sessionId);
                // The creator keeps the default state and reports its real state itself.
                broadcast.safeSend(ws, protocol.build('sessionJoined', { sessionId, clientId: client.id, sessionData }));

            } else if (sessionStore.get(requestedSessionId)) {
                // Session ID found → join the existing session
                if (sessionStore.get(requestedSessionId).clients.length >= limits.maxClientsPerSession) {
                    log.warn(`Refused ${describeClient(client)}: session ${requestedSessionId} is full (${limits.maxClientsPerSession} clients)`, { sessionId: requestedSessionId, limit: limits.maxClientsPerSession }, { throttle: 'session-full' });
                    rejectWith(protocol.ERROR_REASONS.sessionFull);
                    return;
                }
                sessionId = requestedSessionId;
                const initialSyncPatch = adoptSessionState(client, sessionStore.get(sessionId).clients);
                sessionStore.addClient(sessionId, client);
                activity.event(`${describeClient(client)} joined session ${sessionId}`, {
                    event: 'session_joined', sessionId, clientId: client.id, name: client.metadata.name, deviceType: client.metadata.deviceType
                });
                const sessionData = sessionStore.getSessionData(sessionId);
                broadcast.safeSend(ws, protocol.build('sessionJoined', { sessionId, clientId: client.id, sessionData }));
                // Always sent (even with an empty patch): tells the joiner its initial state is complete.
                broadcast.safeSend(ws, protocol.build('syncState', { patch: initialSyncPatch }));
                // Notify the other clients in the session
                const clientData = { id: client.id, metadata: client.metadata };
                broadcast.broadcastToSession(sessionStore.get(sessionId), protocol.build('clientConnected', { clientData, sessionData }), ws);

            } else {
                // Session ID not found → send error and close
                // A mistyped code is routine, not a server problem: info, not warn.
                log.info(`Refused ${describeClient(client)}: session ${quoteForLog(requestedSessionId)} not found`, { sessionId: requestedSessionId }, { throttle: 'session-not-found' });
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
                    log.warn(`${describeClient(client)} exceeded the message rate limit in session ${sessionId}; closing connection`, { sessionId, clientId: client.id }, { throttle: 'rate-limit' });
                    // 1008 = policy violation
                    ws.close(1008, 'rate limit exceeded');
                    return;
                }
                // Payloads are user content: only ever logged at debug level, truncated.
                log.debug(`Message from ${describeClient(client)} in session ${sessionId}: ${String(message).slice(0, 500)}`);
                let messageJson;
                try {
                    messageJson = JSON.parse(message);
                } catch (e) {
                    log.warn(`Ignored unparseable message from ${describeClient(client)}: ${e.message}`, { sessionId, clientId: client.id }, { throttle: 'bad-json' });
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
                    log.error(`Unhandled error while handling a message from ${describeClient(client)} in session ${sessionId}`, { err, sessionId, clientId: client.id });
                }
            });

            ws.on('close', (code) => {
                // Pings, refused connections and members of an already
                // dissolved session have nothing to report here.
                if (!sessionId || !sessionStore.get(sessionId)) return;
                const who = describeClient(client);
                const closeNote = describeClose(code);
                const summary = sessionStore.removeClient(ws, sessionId);
                if (summary) {
                    sessionLogger.logSessionTerminated(summary);
                    activity.event(`${who} left session ${sessionId}${closeNote}; session ended after ${formatDuration(summary.durationMs)} (all members left)`, {
                        event: 'session_ended', sessionId, reason: summary.reason, durationMs: summary.durationMs, clientId: client.id, closeCode: code
                    });
                    return;
                }
                const remainingSession = sessionStore.get(sessionId);
                activity.event(`${who} left session ${sessionId}${closeNote}; ${plural(remainingSession.clients.length, 'member')} remaining`, {
                    event: 'session_left', sessionId, clientId: client.id, closeCode: code
                });
                const clientData = { id: client.id, metadata: client.metadata };
                const sessionData = sessionStore.getSessionData(sessionId);
                broadcast.broadcastToSession(remainingSession, protocol.build('clientDisconnected', { clientData, sessionData }), ws);
            });
        });
    };
}

module.exports = { createUpgradeHandler };
