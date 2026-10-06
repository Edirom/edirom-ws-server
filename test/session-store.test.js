const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createSessionStore, buildTerminationSummary } = require('../src/session-store');

function fakeSocket(readyState = WebSocket.OPEN) {
    return { readyState, send: () => {}, close: () => {} };
}

test('create() starts a new session containing just that client', () => {
    const store = createSessionStore();
    const client = { id: 'c1', ws: fakeSocket() };
    const sessionId = store.create(client);
    assert.equal(typeof sessionId, 'string');
    assert.deepEqual(store.get(sessionId).clients, [client]);
});

test('addClient() joins an existing session', () => {
    const store = createSessionStore();
    const client1 = { id: 'c1', ws: fakeSocket() };
    const sessionId = store.create(client1);
    const client2 = { id: 'c2', ws: fakeSocket() };
    store.addClient(sessionId, client2);
    assert.deepEqual(store.get(sessionId).clients, [client1, client2]);
});

test('removeClient() deletes the session once the last client leaves, returning a termination summary', () => {
    const store = createSessionStore();
    const client = { id: 'c1', ws: fakeSocket(), joinedAt: Date.now() };
    const sessionId = store.create(client);
    const summary = store.removeClient(client.ws, sessionId);
    assert.equal(store.get(sessionId), undefined);
    assert.equal(summary.reason, 'allMembersLeft');
    assert.equal(summary.sessionId, sessionId);
    assert.equal(summary.members.length, 1);
});

test('removeClient() keeps the session alive if others remain, returning null', () => {
    const store = createSessionStore();
    const client1 = { id: 'c1', ws: fakeSocket() };
    const sessionId = store.create(client1);
    const client2 = { id: 'c2', ws: fakeSocket() };
    store.addClient(sessionId, client2);
    const summary = store.removeClient(client1.ws, sessionId);
    assert.deepEqual(store.get(sessionId).clients, [client2]);
    assert.equal(summary, null);
});

test('findClient() locates a client by id within a session', () => {
    const store = createSessionStore();
    const client = { id: 'c1', ws: fakeSocket() };
    const sessionId = store.create(client);
    assert.equal(store.findClient(sessionId, 'c1'), client);
    assert.equal(store.findClient(sessionId, 'missing'), undefined);
});

test('getSessionData() reports id + metadata for every member', () => {
    const store = createSessionStore();
    const client = { id: 'c1', ws: fakeSocket(), metadata: { name: 'Alice', deviceType: 'desktop' } };
    const sessionId = store.create(client);
    assert.deepEqual(store.getSessionData(sessionId), { sessionMembers: [{ id: 'c1', metadata: client.metadata }] });
});

test('getSessionData() returns an empty member list for an unknown session', () => {
    const store = createSessionStore();
    assert.deepEqual(store.getSessionData('NOPE'), { sessionMembers: [] });
});

test('dissolve() returns every open socket, a termination summary, and removes the session', () => {
    const store = createSessionStore();
    const openClient = { id: 'c1', ws: fakeSocket(WebSocket.OPEN), joinedAt: Date.now() };
    const closedClient = { id: 'c2', ws: fakeSocket(WebSocket.CLOSED), joinedAt: Date.now() };
    const sessionId = store.create(openClient);
    store.addClient(sessionId, closedClient);

    const { sockets, summary } = store.dissolve(sessionId);

    assert.deepEqual(sockets, [openClient.ws]);
    assert.equal(store.get(sessionId), undefined);
    assert.equal(summary.reason, 'explicitDissolve');
    assert.equal(summary.members.length, 2);
});

test('dissolve() on an unknown session returns no sockets and no summary', () => {
    const store = createSessionStore();
    assert.deepEqual(store.dissolve('NOPE'), { sockets: [], summary: null });
});

test('count() reflects the number of live sessions', () => {
    const store = createSessionStore();
    assert.equal(store.count(), 0);
    store.create({ id: 'c1', ws: fakeSocket() });
    assert.equal(store.count(), 1);
});

test('peakConcurrentMembers tracks the highest simultaneous membership, not just the final one', () => {
    const store = createSessionStore();
    const client1 = { id: 'c1', ws: fakeSocket(), joinedAt: Date.now() };
    const sessionId = store.create(client1);
    const client2 = { id: 'c2', ws: fakeSocket(), joinedAt: Date.now() };
    store.addClient(sessionId, client2);
    store.removeClient(client1.ws, sessionId);

    const { summary } = store.dissolve(sessionId);
    assert.equal(summary.peakConcurrentMembers, 2);
});

test('roster keeps members who already left, with join/leave order and durations', () => {
    const store = createSessionStore();
    const alice = { id: 'c1', ws: fakeSocket(), joinedAt: 1000, metadata: { name: 'Alice', deviceType: 'desktop' } };
    const sessionId = store.create(alice);
    const bob = { id: 'c2', ws: fakeSocket(), joinedAt: 2000, metadata: { name: 'Bob', deviceType: 'mobile' } };
    store.addClient(sessionId, bob);

    const bobLeftAt = 3000;
    const originalNow = Date.now;
    Date.now = () => bobLeftAt;
    store.removeClient(bob.ws, sessionId);
    Date.now = originalNow;

    const { summary } = store.dissolve(sessionId);
    assert.equal(summary.members.length, 2);

    const aliceSummary = summary.members.find(m => m.id === 'c1');
    const bobSummary = summary.members.find(m => m.id === 'c2');
    assert.equal(aliceSummary.joinOrder, 1);
    assert.equal(bobSummary.joinOrder, 2);
    assert.equal(bobSummary.leaveOrder, 1);
    assert.equal(bobSummary.durationMs, 1000);
    assert.equal(bobSummary.deviceType, 'mobile');
    // Alice was still connected when the session was dissolved, so she's
    // recorded as leaving at dissolve time.
    assert.equal(aliceSummary.leaveOrder, 2);
});

test('dissolveAll() terminates every session at once and returns sockets to notify', () => {
    const store = createSessionStore();
    const openSocket = fakeSocket(WebSocket.OPEN);
    const closedSocket = fakeSocket(WebSocket.CLOSED);
    const sessionId1 = store.create({ id: 'c1', ws: openSocket, joinedAt: Date.now() });
    const sessionId2 = store.create({ id: 'c2', ws: closedSocket, joinedAt: Date.now() });

    const results = store.dissolveAll('serverShutdown');

    assert.equal(results.length, 2);
    assert.ok(results.every(({ summary }) => summary.reason === 'serverShutdown'));
    assert.equal(store.count(), 0);
    assert.deepEqual(new Set(results.map(r => r.summary.sessionId)), new Set([sessionId1, sessionId2]));
    // Only OPEN sockets are returned for the caller to notify+close.
    const allSockets = results.flatMap(r => r.sockets);
    assert.deepEqual(allSockets, [openSocket]);
});

test('buildTerminationSummary() is a pure function of a session snapshot', () => {
    const session = {
        createdAt: 1000,
        peakConcurrentMembers: 1,
        leaveCounter: 0,
        roster: [{ id: 'c1', name: 'Alice', deviceType: 'desktop', joinedAt: 1000, joinOrder: 1, leftAt: null, leaveOrder: null }]
    };
    const summary = buildTerminationSummary(session, 'ABC123', 'explicitDissolve', 5000);

    assert.equal(summary.event, 'session_terminated');
    assert.equal(summary.sessionId, 'ABC123');
    assert.equal(summary.durationMs, 4000);
    assert.equal(summary.members[0].durationMs, 4000);
    assert.equal(summary.members[0].leaveOrder, 1);
    // Calling it again with the same input produces the same output.
    assert.deepEqual(buildTerminationSummary(session, 'ABC123', 'explicitDissolve', 5000), summary);
});

test('overview counts connections per session, oldest session first, with no member details', () => {
    const store = createSessionStore();
    const first = store.create({ id: 'a', ws: {}, metadata: {}, joinedAt: 1 });
    store.addClient(first, { id: 'b', ws: {}, metadata: {}, joinedAt: 2 });
    store.create({ id: 'c', ws: {}, metadata: {}, joinedAt: 3 });

    const { connections, sessions } = store.overview();

    assert.equal(connections, 3);
    assert.deepEqual(sessions.map((s) => [s.sessionId, s.connections]), [[first, 2], [sessions[1].sessionId, 1]]);
    assert.deepEqual(Object.keys(sessions[0]).sort(), ['connections', 'createdAt', 'sessionId']);
});
