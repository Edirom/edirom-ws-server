// Import the WebSocket library
const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require("uuid");

// Create an Express application
const app = express();
const port = 3000;

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

// Handle HTTP upgrade requests to upgrade them to WebSocket connections
server.on('upgrade', (request, socket, head) => {
    console.log("New connection!");
    const url = new URL(request.url, 'http://localhost');
    const requestedSessionId = url.searchParams.get('sessionId')?.toUpperCase() ?? null;
    const clientName = (url.searchParams.get('clientName') ?? 'unknown').slice(0, 64);
    const deviceType = (url.searchParams.get('deviceType') ?? 'unknown').slice(0, 32);

    let client = {
        id: uuidv4(),
        ws: null,
        metadata: { name: clientName, deviceType }
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
            ws.send(JSON.stringify({ response: 'sessionJoined', sessionId, clientId: client.id, sessionData, lastRelayed: sessions[sessionId].lastRelayed ?? null }));

        } else if (sessions[requestedSessionId]) {
            // Session ID found → join the existing session
            sessionId = requestedSessionId;
            sessions[sessionId].clients.push(client);
            console.log(`Client ${client.id} joined session ${sessionId}.`);
            console.log("Clients in this session: ", sessions[sessionId].clients.length);
            const sessionData = getSessionDataForClients();
            ws.send(JSON.stringify({ response: 'sessionJoined', sessionId, clientId: client.id, sessionData, lastRelayed: sessions[sessionId].lastRelayed ?? null }));
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
            } else if (messageJson.type) {
                const targetedClientIds = Array.isArray(messageJson.client_targets) && messageJson.client_targets.length > 0
                    ? messageJson.client_targets
                    : null;
                if (targetedClientIds === null) {
                    sessions[sessionId].lastRelayed = { type: messageJson.type, payload: messageJson.payload };
                }
                sessions[sessionId].clients.forEach(c => {
                    if (c.ws === ws || c.ws.readyState !== WebSocket.OPEN) return;
                    if (targetedClientIds !== null && !targetedClientIds.includes(c.id)) return;
                    c.ws.send(JSON.stringify({ type: messageJson.type, payload: messageJson.payload }));
                });
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

