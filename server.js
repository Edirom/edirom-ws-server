// Import the WebSocket library
const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require("uuid");

// Create an Express application
const app = express();
const port = process.env.PORT || 3000;

// Create an HTTP server using the Express app
const server = require('http').createServer(app);

// Create a WebSocket server, but do not start it yet
const wss = new WebSocket.Server({ noServer: true });

console.log("I run!");

// Object to store WebSocket connections by session ID
const sessions = {};

// Generates a unique 6-character alphanumeric session ID (uppercase, unambiguous charset)
function generateSessionId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id;
    do {
        id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (sessions[id]);
    return id;
}

// ---------------------------------------------------------------------------
// Client state
//
// Every client entry carries a `state` object describing what that client is
// currently showing. Clients report changes with `updateState`; the server
// orchestrates other clients with `syncState`.
//
// STATE_SCHEMA is the single place that defines which keys exist:
//   default   value a fresh client starts with
//   shared    true  → a change is propagated to the other clients in the session
//             false → only stored (e.g. a future per-client "openWindows")
//   validate  returns true for acceptable values; anything else is dropped
//
// Adding a new state key means adding one entry here.
// ---------------------------------------------------------------------------
const isNullableId = (value) => value === null || (typeof value === 'string' && value.length <= 256);

const STATE_SCHEMA = {
    edition: { default: null, shared: true, validate: isNullableId },
    work: { default: null, shared: true, validate: isNullableId },
    // ID of the selected concordance connection; null = none selected / free exploration
    connection: { default: null, shared: true, validate: isNullableId }
};

function createDefaultState() {
    return Object.fromEntries(Object.entries(STATE_SCHEMA).map(([key, def]) => [key, def.default]));
}

// Keeps only known keys with valid values from a client-supplied patch.
function sanitizeStatePatch(patch) {
    const clean = {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clean;
    for (const [key, value] of Object.entries(patch)) {
        const def = STATE_SCHEMA[key];
        if (!def) {
            console.warn(`Ignoring unknown state key "${key}".`);
        } else if (!def.validate(value)) {
            console.warn(`Ignoring invalid value for state key "${key}".`);
        } else {
            clean[key] = value;
        }
    }
    return clean;
}

function getSharedState(state) {
    return Object.fromEntries(Object.keys(STATE_SCHEMA).filter(key => STATE_SCHEMA[key].shared).map(key => [key, state[key]]));
}

function sendSyncState(client, patch) {
    if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type: 'syncState', payload: { patch } }));
    }
}

/**
 * Gives a joining client the current shared state of the session.
 * The reference is the member that reported a state most recently (ties and
 * "nobody reported yet" fall back to the oldest member).
 * @returns {Object} The patch to send to the joiner as its initial `syncState`.
 *   Empty if no member has reported a state yet, so nobody gets reset to defaults.
 */
function adoptSessionState(joiningClient, existingClients) {
    if (existingClients.length === 0) return {};
    const reference = existingClients.reduce((newest, c) => c.stateUpdatedAt > newest.stateUpdatedAt ? c : newest);
    if (reference.stateUpdatedAt === 0) return {};
    const patch = getSharedState(reference.state);
    Object.assign(joiningClient.state, patch);
    return patch;
}

/**
 * Handles a client's `updateState` message ("my state changed").
 *
 * payload: { patch: { <key>: <value>, … }, cause?: "user" | "syncResult" }
 *
 * - Keys/values that are unknown or invalid are dropped.
 * - A patch that changes nothing is ignored.
 * - "user" changes to shared keys are pushed to every other client that
 *   doesn't have that value yet, as one `syncState` per client.
 * - "syncResult" is a client reporting what it actually ended up with after a
 *   `syncState`. It only corrects the sender's own entry and is never fanned
 *   out, so a failed apply can't bounce between clients.
 */
function handleUpdateState(sender, session, payload) {
    const patch = sanitizeStatePatch(payload?.patch);
    const changedKeys = Object.keys(patch).filter(key => sender.state[key] !== patch[key]);
    if (changedKeys.length === 0) return;

    changedKeys.forEach(key => { sender.state[key] = patch[key]; });
    sender.stateUpdatedAt = Date.now();
    console.log(`State of client ${sender.id} updated:`, Object.fromEntries(changedKeys.map(key => [key, patch[key]])));

    if (payload?.cause === 'syncResult') return;

    const changedSharedKeys = changedKeys.filter(key => STATE_SCHEMA[key].shared);
    if (changedSharedKeys.length === 0) return;

    session.clients.forEach(other => {
        if (other === sender) return;
        const otherPatch = {};
        changedSharedKeys.forEach(key => {
            if (other.state[key] !== patch[key]) otherPatch[key] = patch[key];
        });
        if (Object.keys(otherPatch).length === 0) return;
        Object.assign(other.state, otherPatch);
        sendSyncState(other, otherPatch);
    });
}

// Handle HTTP upgrade requests to upgrade them to WebSocket connections
server.on('upgrade', (request, socket, head) => {
    console.log("New connection!");
    const url = new URL(request.url, 'http://localhost');

    if (url.searchParams.get('ping') === 'true') {
        // Lightweight availability check: confirms the WebSocket upgrade path
        // works without creating or touching any session.
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.send(JSON.stringify({ response: 'pong' }));
            ws.close();
        });
        return;
    }

    const requestedSessionId = url.searchParams.get('sessionId')?.toUpperCase() ?? null;
    const clientName = (url.searchParams.get('clientName') ?? 'unknown').slice(0, 64);
    const deviceType = (url.searchParams.get('deviceType') ?? 'unknown').slice(0, 32);

    let client = {
        id: uuidv4(),
        ws: null,
        metadata: { name: clientName, deviceType },
        state: createDefaultState(),
        // 0 = this client never reported a state (joining alone doesn't count)
        stateUpdatedAt: 0
    };
    let sessionId = null;

    wss.handleUpgrade(request, socket, head, (ws) => {
        client.ws = ws;

        if (requestedSessionId === null) {
            // No session ID provided → create a new session
            sessionId = generateSessionId();
            sessions[sessionId] = { clients: [client] };
            console.log(`Created new session ${sessionId} for client ${client.id}.`);
            console.log("Number of sessions: ", Object.keys(sessions).length);
            const sessionData = getSessionDataForClients();
            // The creator keeps the default state and reports its real state itself.
            ws.send(JSON.stringify({ response: 'sessionJoined', sessionId, clientId: client.id, sessionData }));

        } else if (sessions[requestedSessionId]) {
            // Session ID found → join the existing session
            sessionId = requestedSessionId;
            const initialSyncPatch = adoptSessionState(client, sessions[sessionId].clients);
            sessions[sessionId].clients.push(client);
            console.log(`Client ${client.id} joined session ${sessionId}.`);
            console.log("Clients in this session: ", sessions[sessionId].clients.length);
            const sessionData = getSessionDataForClients();
            ws.send(JSON.stringify({ response: 'sessionJoined', sessionId, clientId: client.id, sessionData }));
            // Always sent (even with an empty patch): tells the joiner its initial state is complete.
            sendSyncState(client, initialSyncPatch);
            // Notify the other clients in the session
            const clientData = { id: client.id, metadata: client.metadata };
            sessions[sessionId].clients.forEach(c => {
                if (c.ws !== ws && c.ws.readyState === WebSocket.OPEN) {
                    c.ws.send(JSON.stringify({ response: 'clientConnected', clientData, sessionData }));
                }
            });

        } else {
            // Session ID not found → send error and close
            console.log(`Session ${requestedSessionId} not found. Closing connection.`);
            ws.send(JSON.stringify({ response: 'error', reason: 'sessionNotFound' }));
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
            if (!sessionId || !sessions[sessionId]) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
                return;
            }

            if (messageJson.message === "updateClientName") {
                client.metadata.name = messageJson.clientName ?? 'unknown';
                const sessionData = getSessionDataForClients();
                sessions[sessionId].clients.forEach(c => {
                    if (c.ws !== ws && c.ws.readyState === WebSocket.OPEN) {
                        c.ws.send(JSON.stringify({ response: 'sessionDataUpdated', sessionData }));
                    }
                });
            } else if (messageJson.message === "removeClient") {
                const target = sessions[sessionId]?.clients.find(c => c.id === messageJson.clientId);
                if (target && target.ws.readyState === WebSocket.OPEN) {
                    target.ws.send(JSON.stringify({ response: 'clientRemoved' }));
                    target.ws.close();
                }
            } else if (messageJson.message === "dissolveSession") {
                dissolveSession(sessionId);
            } else if (messageJson.type === "updateState") {
                handleUpdateState(client, sessions[sessionId], messageJson.payload);
            } else if (messageJson.type) {
                console.warn(`Ignoring unknown message type "${messageJson.type}".`);
            }
        });

        ws.on('close', () => {
            console.log("Connection closed!");
            if (!sessionId || !sessions[sessionId]) return;
            removeClient(ws, sessionId);
            const clientData = { id: client.id, metadata: client.metadata };
            if (sessions[sessionId]) {
                const sessionData = getSessionDataForClients();
                const responseJson = { response: "clientDisconnected", clientData, sessionData };
                sessions[sessionId].clients.forEach(c => {
                    if (c.ws !== ws && c.ws.readyState === WebSocket.OPEN) {
                        c.ws.send(JSON.stringify(responseJson));
                    }
                });
            }
        });

        function getSessionDataForClients() {
            if (!sessionId || !sessions[sessionId]) return { sessionMembers: [] };
            const sessionMembers = sessions[sessionId].clients.map(c => ({ id: c.id, metadata: c.metadata }));
            return { sessionMembers };
        }

        function dissolveSession(sessionId) {
            const session = sessions[sessionId];
            if (!session) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
                return;
            }

            const socketsToClose = session.clients
                .map(c => c.ws)
                .filter(socket => socket && socket.readyState === WebSocket.OPEN);

            delete sessions[sessionId];
            console.log(`Session ${sessionId} dissolved.`);
            console.log("Number of sessions: ", Object.keys(sessions).length);

            socketsToClose.forEach(socket => {
                socket.send(JSON.stringify({ response: 'sessionDissolved' }));
                socket.close();
            });
        }

        function removeClient(ws, sessionId) {
            if (!sessions[sessionId]) return;
            sessions[sessionId].clients = sessions[sessionId].clients.filter(c => c.ws !== ws);
            console.log("Clients in this session: ", sessions[sessionId].clients.length);
            if (sessions[sessionId].clients.length === 0) {
                delete sessions[sessionId];
            }
            console.log("Number of sessions: ", Object.keys(sessions).length);
        }

    });
});


// Define a simple HTTP GET route for the root URL
app.get('/', (req, res) => {
    // Send a plain text response
    res.send('WebSocket server is running');
});

// Start the HTTP server and listen on the specified port
server.listen(port, () => {
    console.log(`Server is listening on http://localhost:${port}`);
});

