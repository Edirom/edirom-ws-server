const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createSessionStore } = require('../src/session-store');

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

test('removeClient() deletes the session once the last client leaves', () => {
    const store = createSessionStore();
    const client = { id: 'c1', ws: fakeSocket() };
    const sessionId = store.create(client);
    store.removeClient(client.ws, sessionId);
    assert.equal(store.get(sessionId), undefined);
});

test('removeClient() keeps the session alive if others remain', () => {
    const store = createSessionStore();
    const client1 = { id: 'c1', ws: fakeSocket() };
    const sessionId = store.create(client1);
    const client2 = { id: 'c2', ws: fakeSocket() };
    store.addClient(sessionId, client2);
    store.removeClient(client1.ws, sessionId);
    assert.deepEqual(store.get(sessionId).clients, [client2]);
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

test('dissolve() returns every open socket and removes the session', () => {
    const store = createSessionStore();
    const openClient = { id: 'c1', ws: fakeSocket(WebSocket.OPEN) };
    const closedClient = { id: 'c2', ws: fakeSocket(WebSocket.CLOSED) };
    const sessionId = store.create(openClient);
    store.addClient(sessionId, closedClient);

    const sockets = store.dissolve(sessionId);

    assert.deepEqual(sockets, [openClient.ws]);
    assert.equal(store.get(sessionId), undefined);
});

test('dissolve() on an unknown session returns no sockets', () => {
    const store = createSessionStore();
    assert.deepEqual(store.dissolve('NOPE'), []);
});

test('count() reflects the number of live sessions', () => {
    const store = createSessionStore();
    assert.equal(store.count(), 0);
    store.create({ id: 'c1', ws: fakeSocket() });
    assert.equal(store.count(), 1);
});
