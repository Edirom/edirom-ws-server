const WebSocket = require('ws');
const { createClient } = require('./client');
const { adoptSessionState } = require('./state');
const broadcast = require('./broadcast');
const sessionLogger = require('./session-logger');

// Handles HTTP upgrade requests, turning each one into a client joining
// (or creating) a session, then wires that connection's message/close events.
function createUpgradeHandler({ wss, sessionStore, messageRouter, protocol }) {
    return function handleUpgrade(request, socket, head) {
        console.log("New connection!");
        // Cheap insurance: every path below this point until wss.handleUpgrade()
        // takes over is currently synchronous, but a socket-level 'error' with no
        // listener would crash the process, so cover it unconditionally.
        socket.on('error', (err) => console.error('raw socket error during upgrade:', err));

        const url = new URL(request.url, 'http://localhost');

        if (url.searchParams.get(protocol.CONNECT_PARAMS.ping) === 'true') {
            // Lightweight availability check: confirms the WebSocket upgrade path
            // works without creating or touching any session.
            wss.handleUpgrade(request, socket, head, (ws) => {
                ws.on('error', (err) => console.error('ping ws error:', err));
                ws.send(JSON.stringify(protocol.build('pong')));
                ws.close();
            });
            return;
        }

        const requestedSessionId = url.searchParams.get(protocol.CONNECT_PARAMS.sessionId)?.toUpperCase() ?? null;
        const clientName = (url.searchParams.get(protocol.CONNECT_PARAMS.clientName) ?? 'unknown').slice(0, 64);
        const deviceType = (url.searchParams.get(protocol.CONNECT_PARAMS.deviceType) ?? 'unknown').slice(0, 32);

        const client = createClient({ name: clientName, deviceType });
        let sessionId = null;

        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.on('error', (err) => console.error(`ws error (session ${sessionId ?? 'pending'}, client ${client.id}):`, err));
            client.ws = ws;
            // Heartbeat bookkeeping: 'pong' is the protocol-level control frame
            // ws replies with automatically when we .ping() it below — distinct
            // from the application-level {response:'pong'} JSON message sent on
            // the ?ping=true short path above.
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });

            if (requestedSessionId === null) {
                // No session ID provided → create a new session
                sessionId = sessionStore.create(client);
                const sessionData = sessionStore.getSessionData(sessionId);
                // The creator keeps the default state and reports its real state itself.
                broadcast.safeSend(ws, protocol.build('sessionJoined', { sessionId, clientId: client.id, sessionData }));

            } else if (sessionStore.get(requestedSessionId)) {
                // Session ID found → join the existing session
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
                broadcast.safeSend(ws, protocol.build('error', { reason: protocol.ERROR_REASONS.sessionNotFound }));
                ws.close();
                return;
            }

            ws.on('message', (message) => {
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
