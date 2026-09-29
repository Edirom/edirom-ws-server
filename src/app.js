const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createSessionStore } = require('./session-store');
const { createMessageRouter } = require('./message-router');
const { createUpgradeHandler } = require('./connection');
const broadcast = require('./broadcast');
const state = require('./state');
const { loadProtocol } = require('./load-ws-protocol');

// Wires express + http + ws together without starting to listen, so tests
// can boot a real server on an ephemeral port. Async because the shared
// protocol module (vendored as a git submodule) is a real ES module and
// must be loaded via dynamic import().
async function createServer() {
    const protocol = await loadProtocol();

    const app = express();
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ noServer: true });

    const sessionStore = createSessionStore();
    const messageRouter = createMessageRouter({ sessionStore, broadcast, state, protocol });

    server.on('upgrade', createUpgradeHandler({ wss, sessionStore, messageRouter, protocol }));

    app.get('/', (req, res) => {
        res.send('WebSocket server is running');
    });

    return { server, wss, sessionStore };
}

module.exports = { createServer };
