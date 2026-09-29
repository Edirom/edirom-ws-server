const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createUpgradeHandler } = require('../src/connection');
const { loadProtocol } = require('../src/load-ws-protocol');

function fakeWs() {
    const ws = new EventEmitter();
    ws.readyState = WebSocket.OPEN;
    ws.send = () => {};
    ws.close = () => {};
    return ws;
}

function fakeWss(ws) {
    return { handleUpgrade: (request, socket, head, cb) => cb(ws) };
}

test('a throwing message handler is caught, keeping the connection and session alive', async () => {
    const protocol = await loadProtocol();
    const ws = fakeWs();
    const wss = fakeWss(ws);
    const session = { clients: [] };
    const sessionStore = {
        create: (client) => { session.clients.push(client); return 'SESSION'; },
        get: (id) => (id === 'SESSION' ? session : undefined),
        addClient: () => {},
        removeClient: () => null,
        getSessionData: () => ({ sessionMembers: [] })
    };
    const messageRouter = { handleMessage: () => { throw new Error('boom'); } };

    const handleUpgrade = createUpgradeHandler({ wss, sessionStore, messageRouter, protocol });
    const request = { url: '/?clientName=Alice&deviceType=desktop' };
    const socket = new EventEmitter();

    assert.doesNotThrow(() => handleUpgrade(request, socket, Buffer.alloc(0)));
    assert.doesNotThrow(() => ws.emit('message', JSON.stringify({ message: 'updateClientName', clientName: 'Bob' })));

    // A bug in the handler must not have torn down the session.
    assert.equal(sessionStore.get('SESSION'), session);
});
