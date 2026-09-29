const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/app');
const { listen, connectClient } = require('./helpers');

test('full session lifecycle over the real wire protocol', async (t) => {
    const { server } = await createServer();
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
    const { server } = await createServer();
    const port = await listen(server);
    t.after(() => server.close());

    const client = await connectClient(port, '/?sessionId=NOPE00');
    assert.deepEqual(await client.next(), { response: 'error', reason: 'sessionNotFound' });
});

test('malformed raw frames are ignored without breaking the connection or session', async (t) => {
    const { server } = await createServer();
    const port = await listen(server);
    t.after(() => server.close());

    const alice = await connectClient(port, '/?clientName=Alice&deviceType=desktop');
    const joinedAlice = await alice.next();
    const sessionId = joinedAlice.sessionId;

    const bob = await connectClient(port, `/?sessionId=${sessionId}&clientName=Bob&deviceType=mobile`);
    await bob.next(); // sessionJoined
    await bob.next(); // syncState
    await alice.next(); // clientConnected

    // None of these should crash the server or the connection — the classic
    // one being the literal text "null", which is valid JSON that parses to
    // a non-object.
    alice.ws.send('null');
    alice.ws.send('[1,2,3]');
    alice.ws.send('not even json');
    alice.ws.send('42');

    // The connection and session must still work normally afterward.
    alice.ws.send(JSON.stringify({ type: 'updateState', payload: { patch: { edition: 'ed-1' }, cause: 'user' } }));
    assert.deepEqual(await bob.next(), { type: 'syncState', payload: { patch: { edition: 'ed-1' } } });

    alice.ws.close();
    bob.ws.close();
});

test('an oversized message closes only that connection, not the whole server', async (t) => {
    const { server } = await createServer();
    const port = await listen(server);
    t.after(() => server.close());

    const alice = await connectClient(port, '/?clientName=Alice&deviceType=desktop');
    await alice.next(); // sessionJoined

    const closed = new Promise((resolve) => alice.ws.once('close', resolve));
    alice.ws.send('x'.repeat(70 * 1024)); // over the 64KB maxPayload cap
    await closed;

    // A second, independent session is unaffected.
    const bob = await connectClient(port, '/?clientName=Bob&deviceType=desktop');
    const joinedBob = await bob.next();
    assert.equal(joinedBob.response, 'sessionJoined');

    bob.ws.close();
});

test('terminating a dead connection (as the heartbeat sweep would) cleans up the session like a normal close', async (t) => {
    const { server, wss } = await createServer();
    const port = await listen(server);
    t.after(() => server.close());

    const alice = await connectClient(port, '/?clientName=Alice&deviceType=desktop');
    const joinedAlice = await alice.next();
    const sessionId = joinedAlice.sessionId;

    const bob = await connectClient(port, `/?sessionId=${sessionId}&clientName=Bob&deviceType=mobile`);
    await bob.next(); // sessionJoined
    await bob.next(); // syncState
    await alice.next(); // clientConnected

    const serverSockets = Array.from(wss.clients);
    assert.equal(serverSockets.length, 2);
    serverSockets[1].terminate(); // Bob connected second; simulate the heartbeat declaring it dead

    const disconnectMsg = await alice.next();
    assert.equal(disconnectMsg.response, 'clientDisconnected');
    assert.equal(disconnectMsg.clientData.metadata.name, 'Bob');

    alice.ws.close();
});
