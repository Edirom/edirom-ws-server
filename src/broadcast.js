const WebSocket = require('ws');

// The only place in the codebase that should call ws.send()/ws.close() for
// application messages — keeps state.js and session-store.js transport-free.

function safeSend(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

function broadcastToSession(session, obj, excludeWs) {
    session.clients.forEach(c => {
        if (c.ws === excludeWs) return;
        safeSend(c.ws, obj);
    });
}

// For sockets already known to be open (e.g. session-store.dissolve()'s
// return value) — sends then closes, matching the server's "tell them why,
// then disconnect them" responses (sessionDissolved, clientRemoved).
function closeWithMessage(sockets, obj) {
    sockets.forEach(ws => {
        ws.send(JSON.stringify(obj));
        ws.close();
    });
}

module.exports = { safeSend, broadcastToSession, closeWithMessage };
