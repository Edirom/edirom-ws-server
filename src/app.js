const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createSessionStore } = require('./session-store');
const { createMessageRouter } = require('./message-router');
const { createUpgradeHandler } = require('./connection');
const broadcast = require('./broadcast');
const state = require('./state');
const { loadProtocol } = require('./load-ws-protocol');
const { startHeartbeat } = require('./heartbeat');

// Wires express + http + ws together without starting to listen, so tests
// can boot a real server on an ephemeral port. Async because the shared
// protocol module (vendored as a git submodule) is a real ES module and
// must be loaded via dynamic import().
async function createServer() {
    const protocol = await loadProtocol();

    const app = express();
    const server = http.createServer(app);
    // Actual payloads (names, session ids, small state patches) are tiny;
    // capping here bounds per-message memory use against a buggy/oversized client.
    const wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 });
    wss.on('error', (err) => console.error('WebSocket.Server error:', err));
    server.on('error', (err) => console.error('http server error:', err));

    const sessionStore = createSessionStore();
    const messageRouter = createMessageRouter({ sessionStore, broadcast, state, protocol });

    server.on('upgrade', createUpgradeHandler({ wss, sessionStore, messageRouter, protocol }));

    // Reaps sockets that stop responding (e.g. a dropped network) so they
    // don't linger as ghost clients for months. Torn down when the http
    // server fully closes (real shutdown, and every test's server.close()).
    const stopHeartbeat = startHeartbeat(wss);
    server.on('close', stopHeartbeat);

    app.get('/', (req, res) => {
        res.send('WebSocket server is running');
    });

    // Read-only introspection into current in-memory state. Fails closed if
    // DEBUG_TOKEN isn't configured, rather than running unauthenticated.
    if (!process.env.DEBUG_TOKEN) {
        console.warn('DEBUG_TOKEN is not set — GET /debug/sessions is disabled.');
    }
    app.get('/debug/sessions', (req, res) => {
        const token = process.env.DEBUG_TOKEN;
        if (!token || req.get('X-Debug-Token') !== token) {
            res.status(404).end();
            return;
        }
        res.json({ sessionCount: sessionStore.count(), sessions: sessionStore.listSessions() });
    });

    return { server, wss, sessionStore, protocol };
}

module.exports = { createServer };
