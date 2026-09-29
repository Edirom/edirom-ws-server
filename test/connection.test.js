const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createUpgradeHandler } = require('../src/connection');
const { loadProtocol } = require('../src/load-ws-protocol');

function fakeWs() {
    const ws = new EventEmitter();
    ws.readyState = WebSocket.OPEN;
    ws.sent = [];
    ws.closeCalls = [];
    ws.send = (data) => { ws.sent.push(JSON.parse(data)); };
    ws.close = (...args) => { ws.closeCalls.push(args); };
    return ws;
}

function fakeWss(ws, { clientCount = 0 } = {}) {
    const wss = {
        clients: { size: clientCount },
        upgradeCalls: 0,
        handleUpgrade: (request, socket, head, cb) => { wss.upgradeCalls += 1; cb(ws); }
    };
    return wss;
}

function fakeSocket() {
    const socket = new EventEmitter();
    socket.ended = null;
    socket.end = (data) => { socket.ended = data; };
    return socket;
}

function fakeSessionStore(session = { clients: [] }) {
    return {
        create: (client) => { session.clients.push(client); return 'SESSION'; },
        get: (id) => (id === 'SESSION' ? session : undefined),
        count: () => 0,
        addClient: () => {},
        removeClient: () => null,
        getSessionData: () => ({ sessionMembers: [] })
    };
}

test('a throwing message handler is caught, keeping the connection and session alive', async () => {
    const protocol = await loadProtocol();
    const ws = fakeWs();
    const wss = fakeWss(ws);
    const session = { clients: [] };
    const sessionStore = fakeSessionStore(session);
    const messageRouter = { handleMessage: () => { throw new Error('boom'); } };

    const handleUpgrade = createUpgradeHandler({ wss, sessionStore, messageRouter, protocol });
    const request = { url: `/?protocolVersion=${protocol.PROTOCOL_VERSION}&clientName=Alice&deviceType=desktop` };
    const socket = fakeSocket();

    assert.doesNotThrow(() => handleUpgrade(request, socket, Buffer.alloc(0)));
    assert.doesNotThrow(() => ws.emit('message', JSON.stringify({ message: 'updateClientName', clientName: 'Bob' })));

    // A bug in the handler must not have torn down the session.
    assert.equal(sessionStore.get('SESSION'), session);
});

test('an unparseable request URL is refused with 400 instead of throwing', async () => {
    const protocol = await loadProtocol();
    const wss = fakeWss(fakeWs());
    const handleUpgrade = createUpgradeHandler({ wss, sessionStore: fakeSessionStore(), messageRouter: {}, protocol });
    const socket = fakeSocket();

    // "//" is the request target that made `new URL()` throw and killed the server.
    assert.doesNotThrow(() => handleUpgrade({ url: '//' }, socket, Buffer.alloc(0)));

    assert.match(socket.ended, /^HTTP\/1\.1 400 Bad Request/);
    assert.equal(wss.upgradeCalls, 0);
});

test('a connection over the total connection limit is refused with 503 before the handshake', async () => {
    const protocol = await loadProtocol();
    const wss = fakeWss(fakeWs(), { clientCount: 2 });
    const limits = { maxConnections: 2, maxSessions: 10, maxClientsPerSession: 10, messageRatePerSec: 40, messageBurst: 80 };
    const handleUpgrade = createUpgradeHandler({ wss, sessionStore: fakeSessionStore(), messageRouter: {}, protocol, limits });
    const socket = fakeSocket();

    handleUpgrade({ url: `/?protocolVersion=${protocol.PROTOCOL_VERSION}` }, socket, Buffer.alloc(0));

    assert.match(socket.ended, /^HTTP\/1\.1 503 Service Unavailable/);
    assert.equal(wss.upgradeCalls, 0);
});

test('a client that exceeds the message rate limit is closed with 1008 and its later messages are ignored', async () => {
    const protocol = await loadProtocol();
    const ws = fakeWs();
    const handled = [];
    const messageRouter = { handleMessage: (ctx, message) => handled.push(message) };
    const limits = { maxConnections: 10, maxSessions: 10, maxClientsPerSession: 10, messageRatePerSec: 1, messageBurst: 3 };
    const handleUpgrade = createUpgradeHandler({ wss: fakeWss(ws), sessionStore: fakeSessionStore(), messageRouter, protocol, limits });

    handleUpgrade({ url: `/?protocolVersion=${protocol.PROTOCOL_VERSION}` }, fakeSocket(), Buffer.alloc(0));

    const msg = JSON.stringify({ type: 'updateState', payload: { patch: {} } });
    for (let i = 0; i < 6; i++) ws.emit('message', msg);

    assert.equal(handled.length, 3, 'only the burst is processed');
    assert.equal(ws.closeCalls.length, 1, 'closed exactly once');
    assert.equal(ws.closeCalls[0][0], 1008);
});
