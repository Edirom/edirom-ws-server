const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { createMessageRouter } = require('../src/message-router');
const { loadProtocol } = require('../src/load-ws-protocol');
const { createLogger } = require('../src/logger');

// A real logger writing into arrays, so tests assert on actual output lines.
function capturingLogger(options) {
    const lines = [];
    const sink = { write: (line) => lines.push(line.trimEnd()) };
    return Object.assign(createLogger({ out: sink, err: sink, ...options }), { lines });
}

function fakeSocket() {
    return { readyState: WebSocket.OPEN, send: () => {}, close: () => {} };
}

function fakeBroadcast() {
    const sent = [];
    return {
        sent,
        safeSend: (ws, obj) => sent.push({ ws, obj }),
        broadcastToSession: (session, obj, excludeWs) => {
            session.clients.forEach(c => { if (c.ws !== excludeWs) sent.push({ ws: c.ws, obj }); });
        },
        closeWithMessage: (sockets, obj) => sockets.forEach(ws => sent.push({ ws, obj }))
    };
}

function fakeSessionStore(session) {
    return {
        get: () => session,
        getSessionData: () => ({ sessionMembers: session.clients.map(c => ({ id: c.id, metadata: c.metadata })) }),
        findClient: (sessionId, clientId) => session.clients.find(c => c.id === clientId),
        overview: () => ({ connections: 0, sessions: [] }),
        dissolve: () => ({ sockets: session.clients.map(c => c.ws), summary: null })
    };
}

test('ws-protocol.js has zero import statements (server must never need its sibling repo)', () => {
    const filePath = path.join(__dirname, '..', 'vendor', 'edirom-connected-workspace', 'ws-protocol.js');
    const source = fs.readFileSync(filePath, 'utf8');
    assert.ok(!/^\s*import\b/m.test(source), 'ws-protocol.js must not import anything');
});

test('createMessageRouter throws if a toServer message has no handler', async () => {
    const protocol = await loadProtocol();
    const brokenProtocol = {
        ...protocol,
        MESSAGES_TO_SERVER: { ...protocol.MESSAGES_TO_SERVER, madeUp: { channel: 'message', build: () => ({}) } }
    };
    assert.throws(() => createMessageRouter({ sessionStore: {}, broadcast: {}, state: {}, protocol: brokenProtocol }));
});

test('createMessageRouter throws if a handler has no corresponding registry entry', async () => {
    const protocol = await loadProtocol();
    // Simulate a stale handler by removing a message the router still implements a handler for.
    const brokenProtocol = { ...protocol, MESSAGES_TO_SERVER: { ...protocol.MESSAGES_TO_SERVER } };
    delete brokenProtocol.MESSAGES_TO_SERVER.dissolveSession;
    assert.throws(() => createMessageRouter({ sessionStore: {}, broadcast: {}, state: {}, protocol: brokenProtocol }));
});

test('dispatch: a recognized "message" value is handled', async () => {
    const protocol = await loadProtocol();
    const sender = { id: 'c1', ws: fakeSocket(), metadata: { name: 'Alice' } };
    const session = { clients: [sender] };
    const broadcast = fakeBroadcast();
    const router = createMessageRouter({ sessionStore: fakeSessionStore(session), broadcast, state: {}, protocol });

    router.handleMessage({ client: sender, sessionId: 'S1', ws: sender.ws }, { message: 'updateClientName', clientName: 'Bob' });

    assert.equal(sender.metadata.name, 'Bob');
});

test('dispatch: an unrecognized "message" value silently falls through to the type check', async () => {
    const protocol = await loadProtocol();
    const sender = { id: 'c1', ws: fakeSocket(), metadata: { name: 'Alice' }, state: { edition: null, work: null, connection: null }, stateUpdatedAt: 0 };
    const session = { clients: [sender] };
    const broadcast = fakeBroadcast();
    const router = createMessageRouter({ sessionStore: fakeSessionStore(session), broadcast, state: require('../src/state'), protocol });

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
        router.handleMessage({ client: sender, sessionId: 'S1', ws: sender.ws }, { message: 'bogus', type: 'updateState', payload: { patch: { edition: 'ed-1' } } });
    } finally {
        console.warn = originalWarn;
    }

    // The unrecognized `message` value produced no warning on its own, and
    // dispatch fell through to the still-present `type` field.
    assert.equal(warnings.length, 0);
    assert.equal(sender.state.edition, 'ed-1');
});

test('dispatch: an unrecognized "message" with no "type" produces no handler call and no warning', async () => {
    const protocol = await loadProtocol();
    const sender = { id: 'c1', ws: fakeSocket() };
    const session = { clients: [sender] };
    const broadcast = fakeBroadcast();
    const router = createMessageRouter({ sessionStore: fakeSessionStore(session), broadcast, state: {}, protocol });

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
        router.handleMessage({ client: sender, sessionId: 'S1', ws: sender.ws }, { message: 'bogus' });
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(warnings.length, 0);
    assert.equal(broadcast.sent.length, 0);
});

test('handleMessage ignores null/array/primitive payloads instead of throwing', async () => {
    const protocol = await loadProtocol();
    const sender = { id: 'c1', ws: fakeSocket(), metadata: { name: 'Alice' } };
    const session = { clients: [sender] };
    const broadcast = fakeBroadcast();
    const router = createMessageRouter({ sessionStore: fakeSessionStore(session), broadcast, state: {}, protocol });
    const ctx = { client: sender, sessionId: 'S1', ws: sender.ws };

    assert.doesNotThrow(() => router.handleMessage(ctx, null));
    assert.doesNotThrow(() => router.handleMessage(ctx, [1, 2, 3]));
    assert.doesNotThrow(() => router.handleMessage(ctx, 'just a string'));
    assert.doesNotThrow(() => router.handleMessage(ctx, 42));
    assert.equal(broadcast.sent.length, 0);
});

test('updateClientName ignores a non-string clientName', async () => {
    const protocol = await loadProtocol();
    const sender = { id: 'c1', ws: fakeSocket(), metadata: { name: 'Alice' } };
    const session = { clients: [sender] };
    const broadcast = fakeBroadcast();
    const router = createMessageRouter({ sessionStore: fakeSessionStore(session), broadcast, state: {}, protocol });

    router.handleMessage({ client: sender, sessionId: 'S1', ws: sender.ws }, { message: 'updateClientName', clientName: { evil: 'object' } });

    assert.equal(sender.metadata.name, 'unknown');
});

test('updateClientName strips control characters and caps the name at 64 characters', async () => {
    const protocol = await loadProtocol();
    const sender = { id: 'c1', ws: fakeSocket(), metadata: { name: 'Alice' } };
    const session = { clients: [sender] };
    const router = createMessageRouter({ sessionStore: fakeSessionStore(session), broadcast: fakeBroadcast(), state: {}, protocol });

    router.handleMessage({ client: sender, sessionId: 'S1', ws: sender.ws }, { message: 'updateClientName', clientName: 'Bo\nb' + 'y'.repeat(500) });

    assert.equal(sender.metadata.name, 'Bob' + 'y'.repeat(61));
});

test('dispatch: an unrecognized "type" value is logged', async () => {
    const protocol = await loadProtocol();
    const sender = { id: 'c1', ws: fakeSocket() };
    const session = { clients: [sender] };
    const broadcast = fakeBroadcast();
    const log = capturingLogger();
    const router = createMessageRouter({ sessionStore: fakeSessionStore(session), broadcast, state: {}, protocol, log });

    router.handleMessage({ client: sender, sessionId: 'S1', ws: sender.ws }, { type: 'bogus' });

    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /WARN.*bogus/);
});
