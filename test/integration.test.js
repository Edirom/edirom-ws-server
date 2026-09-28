const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer } = require('../src/app');

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, () => resolve(server.address().port));
    });
}

// Buffers incoming messages from the moment the socket is created, so a
// message the server sends before the test calls next() is never missed.
function connectClient(port, query = '') {
    const ws = new WebSocket(`ws://localhost:${port}${query}`);
    const queue = [];
    const waiters = [];
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (waiters.length > 0) waiters.shift()(msg);
        else queue.push(msg);
    });
    const next = () => (queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve)));
    return new Promise((resolve, reject) => {
        ws.once('open', () => resolve({ ws, next }));
        ws.once('error', reject);
    });
}

test('full session lifecycle over the real wire protocol', async (t) => {
    const { server } = createServer();
    const port = await listen(server);
    t.after(() => server.close());

    const pinger = await connectClient(port, '/?ping=true');
    assert.deepEqual(await pinger.next(), { response: 'pong' });

    const alice = await connectClient(port, '/?clientName=Alice&deviceType=desktop');
    const joinedAlice = await alice.next();
    assert.equal(joinedAlice.response, 'sessionJoined');
    assert.equal(joinedAlice.sessionData.sessionMembers.length, 1);
    const sessionId = joinedAlice.sessionId;

    const bob = await connectClient(port, `/?sessionId=${sessionId}&clientName=Bob&deviceType=mobile`);
    const joinedBob = await bob.next();
    assert.equal(joinedBob.response, 'sessionJoined');
    assert.equal(joinedBob.sessionId, sessionId);

    const syncBob = await bob.next();
    assert.deepEqual(syncBob, { type: 'syncState', payload: { patch: {} } });

    const connectedOnAlice = await alice.next();
    assert.equal(connectedOnAlice.response, 'clientConnected');
    assert.equal(connectedOnAlice.clientData.metadata.name, 'Bob');

    alice.ws.send(JSON.stringify({ type: 'updateState', payload: { patch: { edition: 'ed-1' }, cause: 'user' } }));
    assert.deepEqual(await bob.next(), { type: 'syncState', payload: { patch: { edition: 'ed-1' } } });

    bob.ws.close();
    const disconnectMsg = await alice.next();
    assert.equal(disconnectMsg.response, 'clientDisconnected');
    assert.equal(disconnectMsg.clientData.metadata.name, 'Bob');

    alice.ws.send(JSON.stringify({ message: 'dissolveSession' }));
    assert.deepEqual(await alice.next(), { response: 'sessionDissolved' });
});

test('joining an unknown session returns an error and closes the socket', async (t) => {
    const { server } = createServer();
    const port = await listen(server);
    t.after(() => server.close());

    const client = await connectClient(port, '/?sessionId=NOPE00');
    assert.deepEqual(await client.next(), { response: 'error', reason: 'sessionNotFound' });
});
