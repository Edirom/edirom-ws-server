const test = require('node:test');
const assert = require('node:assert/strict');
const { sweep } = require('../src/heartbeat');

function fakeWs() {
    return {
        isAlive: true,
        pinged: false,
        terminated: false,
        ping() { this.pinged = true; },
        terminate() { this.terminated = true; }
    };
}

test('sweep pings a live connection and marks it unconfirmed until the next pong', () => {
    const ws = fakeWs();
    const wss = { clients: new Set([ws]) };

    sweep(wss);

    assert.equal(ws.pinged, true);
    assert.equal(ws.isAlive, false);
    assert.equal(ws.terminated, false);
});

test('sweep terminates a connection that never answered the previous ping', () => {
    const ws = fakeWs();
    const wss = { clients: new Set([ws]) };

    sweep(wss); // pings, marks not-yet-confirmed
    sweep(wss); // no pong arrived in between -> still not-alive -> terminate

    assert.equal(ws.terminated, true);
});

test('sweep leaves a connection that ponged back alone', () => {
    const ws = fakeWs();
    const wss = { clients: new Set([ws]) };

    sweep(wss);
    ws.isAlive = true; // simulates the 'pong' listener firing between sweeps
    sweep(wss);

    assert.equal(ws.terminated, false);
    assert.equal(ws.pinged, true);
});
