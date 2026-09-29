const WebSocket = require('ws');
const { createClient } = require('./client');
const { adoptSessionState } = require('./state');
const broadcast = require('./broadcast');

// Handles HTTP upgrade requests, turning each one into a client joining
// (or creating) a session, then wires that connection's message/close events.
function createUpgradeHandler({ wss, sessionStore, messageRouter, protocol }) {
    return function handleUpgrade(request, socket, head) {
        console.log("New connection!");
        const url = new URL(request.url, 'http://localhost');

        if (url.searchParams.get(protocol.CONNECT_PARAMS.ping) === 'true') {
            // Lightweight availability check: confirms the WebSocket upgrade path
            // works without creating or touching any session.
            wss.handleUpgrade(request, socket, head, (ws) => {
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
            client.ws = ws;

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
                messageRouter.handleMessage({ client, sessionId, ws }, messageJson);
            });

            ws.on('close', () => {
                console.log("Connection closed!");
                if (!sessionId || !sessionStore.get(sessionId)) return;
                sessionStore.removeClient(ws, sessionId);
                const remainingSession = sessionStore.get(sessionId);
                if (remainingSession) {
                    const clientData = { id: client.id, metadata: client.metadata };
                    const sessionData = sessionStore.getSessionData(sessionId);
                    broadcast.broadcastToSession(remainingSession, protocol.build('clientDisconnected', { clientData, sessionData }), ws);
                }
            });
        });
    };
}

module.exports = { createUpgradeHandler };
