const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const WebSocket = require('ws');
const { createServer } = require('../src/app');
const { listen, connectClient, buildUrl, getProtocol } = require('./helpers');

// Boots a real server on an ephemeral port with optional limit overrides.
async function startServer(t, limits) {
    const { server, wss } = await createServer({ limits });
    const port = await listen(server);
    t.after(() => server.close());
    return { server, wss, port };
}

// Sends one raw HTTP upgrade request with an arbitrary request target — what
// a hostile client can do that a WebSocket library never would.
function rawUpgrade(port, target) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
            socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        });
        let response = '';
        socket.on('data', (chunk) => { response += chunk.toString(); });
        socket.on('close', () => resolve(response));
        socket.on('error', reject);
    });
}

test('a request target that used to crash the server is refused with 400 and the server keeps running', async (t) => {
    const { port } = await startServer(t);

    const response = await rawUpgrade(port, '//');
    assert.match(response, /^HTTP\/1\.1 400 Bad Request/);

    const alice = await connectClient(port, '/?clientName=Alice&deviceType=desktop');
    assert.equal((await alice.next()).response, 'sessionJoined');
    alice.ws.close();
});

test('a client without a protocolVersion is refused with protocolMismatch', async (t) => {
    const { port } = await startServer(t);
    const protocol = await getProtocol();

    const client = await connectClient(port, '/?clientName=Alice&deviceType=desktop', { protocolVersion: null });
    assert.deepEqual(await client.next(), { response: 'error', reason: 'protocolMismatch', serverVersion: protocol.PROTOCOL_VERSION });
    await new Promise((resolve) => client.ws.once('close', resolve));
});

test('a client with a different protocolVersion is refused with protocolMismatch and creates no session', async (t) => {
    const { port } = await startServer(t);
    const protocol = await getProtocol();

    const client = await connectClient(port, '/?clientName=Alice&deviceType=desktop', { protocolVersion: protocol.PROTOCOL_VERSION + 1 });
    assert.deepEqual(await client.next(), { response: 'error', reason: 'protocolMismatch', serverVersion: protocol.PROTOCOL_VERSION });
    await new Promise((resolve) => client.ws.once('close', resolve));

    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200); // still healthy
});

test('a ping is answered with protocolMismatch when the versions differ, and with pong when they match', async (t) => {
    const { port } = await startServer(t);
    const protocol = await getProtocol();

    const badPing = await connectClient(port, '/?ping=true', { protocolVersion: 999 });
    assert.deepEqual(await badPing.next(), { response: 'error', reason: 'protocolMismatch', serverVersion: protocol.PROTOCOL_VERSION });

    const goodPing = await connectClient(port, '/?ping=true');
    assert.deepEqual(await goodPing.next(), { response: 'pong' });
});

test('the connect URLs built by the shared protocol module are accepted by the server', async (t) => {
    const { port } = await startServer(t);
    const protocol = await getProtocol();
    const wsUrl = `ws://localhost:${port}`;

    const ping = new WebSocket(protocol.buildPingUrl(wsUrl));
    const pong = await new Promise((resolve) => ping.once('message', (data) => resolve(JSON.parse(data))));
    assert.deepEqual(pong, { response: 'pong' });

    const join = new WebSocket(protocol.buildConnectUrl(wsUrl, { clientName: 'Alice', deviceType: 'desktop' }));
    const joined = await new Promise((resolve) => join.once('message', (data) => resolve(JSON.parse(data))));
    assert.equal(joined.response, 'sessionJoined');
    join.close();
});

test('creating a session beyond the session limit is refused with serverFull, joining an existing one still works', async (t) => {
    const { port } = await startServer(t, { maxSessions: 1 });

    const alice = await connectClient(port, '/?clientName=Alice&deviceType=desktop');
    const joinedAlice = await alice.next();
    assert.equal(joinedAlice.response, 'sessionJoined');

    const overflow = await connectClient(port, '/?clientName=Carol&deviceType=desktop');
    assert.deepEqual(await overflow.next(), { response: 'error', reason: 'serverFull' });

    const bob = await connectClient(port, `/?sessionId=${joinedAlice.sessionId}&clientName=Bob&deviceType=mobile`);
    assert.equal((await bob.next()).response, 'sessionJoined');

    alice.ws.close();
    bob.ws.close();
});

test('joining a full session is refused with sessionFull without disturbing its members', async (t) => {
    const { port } = await startServer(t, { maxClientsPerSession: 2 });

    const alice = await connectClient(port, '/?clientName=Alice&deviceType=desktop');
    const joinedAlice = await alice.next();
    const bob = await connectClient(port, `/?sessionId=${joinedAlice.sessionId}&clientName=Bob&deviceType=mobile`);
    assert.equal((await bob.next()).response, 'sessionJoined');
    await bob.next(); // syncState
    assert.equal((await alice.next()).response, 'clientConnected');

    const carol = await connectClient(port, `/?sessionId=${joinedAlice.sessionId}&clientName=Carol&deviceType=tablet`);
    assert.deepEqual(await carol.next(), { response: 'error', reason: 'sessionFull' });

    // Alice must not have been told that Carol joined.
    alice.ws.send(JSON.stringify({ type: 'updateState', payload: { patch: { edition: 'ed-1' }, cause: 'user' } }));
    assert.deepEqual(await bob.next(), { type: 'syncState', payload: { patch: { edition: 'ed-1' } } });

    alice.ws.close();
    bob.ws.close();
});

test('a connection over the total connection limit is refused with HTTP 503 and admitted again once one closes', async (t) => {
    const { port } = await startServer(t, { maxConnections: 1 });

    const alice = await connectClient(port, '/?clientName=Alice&deviceType=desktop');
    await alice.next();

    const refused = new WebSocket(await buildUrl(port, '/?clientName=Bob&deviceType=desktop'));
    const status = await new Promise((resolve, reject) => {
        refused.once('unexpected-response', (req, res) => resolve(res.statusCode));
        refused.once('open', () => reject(new Error('connection should have been refused')));
        refused.once('error', () => {}); // ws also emits 'error' after unexpected-response is consumed
    });
    assert.equal(status, 503);

    const closed = new Promise((resolve) => alice.ws.once('close', resolve));
    alice.ws.close();
    await closed;
    // The server removes the socket from wss.clients on its own 'close'; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const bob = await connectClient(port, '/?clientName=Bob&deviceType=desktop');
    assert.equal((await bob.next()).response, 'sessionJoined');
    bob.ws.close();
});

test('a client flooding messages is closed with 1008 while other clients keep working', async (t) => {
    const { port } = await startServer(t, { messageBurst: 5, messageRatePerSec: 1 });

    const alice = await connectClient(port, '/?clientName=Alice&deviceType=desktop');
    const joinedAlice = await alice.next();
    const bob = await connectClient(port, `/?sessionId=${joinedAlice.sessionId}&clientName=Bob&deviceType=mobile`);
    await bob.next(); // sessionJoined
    await bob.next(); // syncState
    await alice.next(); // clientConnected

    const closeCode = new Promise((resolve) => alice.ws.once('close', (code) => resolve(code)));
    for (let i = 0; i < 50; i++) {
        alice.ws.send(JSON.stringify({ type: 'updateState', payload: { patch: { edition: `ed-${i}` }, cause: 'user' } }));
    }
    assert.equal(await closeCode, 1008);

    // Bob is unaffected and is told that Alice left.
    let msg;
    do { msg = await bob.next(); } while (msg.response !== 'clientDisconnected');
    assert.equal(msg.clientData.metadata.name, 'Alice');

    bob.ws.close();
});

test('an oversized or control-character client name is sanitised, on connect and on rename', async (t) => {
    const { port } = await startServer(t);

    const alice = await connectClient(port, `/?clientName=${encodeURIComponent('Al\nice' + 'x'.repeat(200))}&deviceType=desktop`);
    const joinedAlice = await alice.next();
    const aliceName = joinedAlice.sessionData.sessionMembers[0].metadata.name;
    assert.equal(aliceName.length, 64);
    assert.ok(!aliceName.includes('\n'));

    const bob = await connectClient(port, `/?sessionId=${joinedAlice.sessionId}&clientName=Bob&deviceType=mobile`);
    await bob.next(); // sessionJoined
    await bob.next(); // syncState
    await alice.next(); // clientConnected

    bob.ws.send(JSON.stringify({ message: 'updateClientName', clientName: 'B\u0000o‮b' + 'y'.repeat(60000) }));
    const update = await alice.next();
    assert.equal(update.response, 'sessionDataUpdated');
    const bobName = update.sessionData.sessionMembers.find((m) => m.metadata.name.startsWith('Bob')).metadata.name;
    assert.equal(bobName.length, 64);
    assert.ok(bobName.startsWith('Boby'));

    alice.ws.close();
    bob.ws.close();
});
