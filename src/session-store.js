const WebSocket = require('ws');

// Generates a unique 6-character alphanumeric session ID (uppercase, unambiguous charset)
function generateSessionId(sessions) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id;
    do {
        id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (sessions[id]);
    return id;
}

// Owns the in-memory sessions map. Never sends/closes a socket itself —
// dissolve()/removeClient() return data for the caller to act on, so this
// stays testable with plain fake socket objects.
function createSessionStore() {
    const sessions = {};

    function create(client) {
        const sessionId = generateSessionId(sessions);
        sessions[sessionId] = { clients: [client] };
        console.log(`Created new session ${sessionId} for client ${client.id}.`);
        console.log("Number of sessions: ", Object.keys(sessions).length);
        return sessionId;
    }

    function get(sessionId) {
        return sessions[sessionId];
    }

    function addClient(sessionId, client) {
        sessions[sessionId].clients.push(client);
        console.log(`Client ${client.id} joined session ${sessionId}.`);
        console.log("Clients in this session: ", sessions[sessionId].clients.length);
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

    function findClient(sessionId, clientId) {
        return sessions[sessionId]?.clients.find(c => c.id === clientId);
    }

    function getSessionData(sessionId) {
        if (!sessionId || !sessions[sessionId]) return { sessionMembers: [] };
        const sessionMembers = sessions[sessionId].clients.map(c => ({ id: c.id, metadata: c.metadata }));
        return { sessionMembers };
    }

    // Returns the sockets that were open at the time of dissolving, so the
    // caller can notify and close them; the session itself is already gone
    // by the time this returns.
    function dissolve(sessionId) {
        const session = sessions[sessionId];
        if (!session) return [];

        const socketsToClose = session.clients
            .map(c => c.ws)
            .filter(socket => socket && socket.readyState === WebSocket.OPEN);

        delete sessions[sessionId];
        console.log(`Session ${sessionId} dissolved.`);
        console.log("Number of sessions: ", Object.keys(sessions).length);

        return socketsToClose;
    }

    function count() {
        return Object.keys(sessions).length;
    }

    return { create, get, addClient, removeClient, findClient, getSessionData, dissolve, count };
}

module.exports = { createSessionStore };
