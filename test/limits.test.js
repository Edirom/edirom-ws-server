const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_LIMITS, loadLimits } = require('../src/limits');

test('loadLimits returns the defaults when no env var is set', () => {
    assert.deepEqual(loadLimits({}), DEFAULT_LIMITS);
});

test('the defaults match the agreed caps', () => {
    assert.equal(DEFAULT_LIMITS.maxConnections, 1000);
    assert.equal(DEFAULT_LIMITS.maxSessions, 1000);
    assert.equal(DEFAULT_LIMITS.maxClientsPerSession, 100);
    assert.equal(DEFAULT_LIMITS.messageRatePerSec, 40);
    assert.equal(DEFAULT_LIMITS.messageBurst, 80);
});

test('loadLimits applies valid env overrides', () => {
    const limits = loadLimits({ MAX_CONNECTIONS: '50', MAX_SESSIONS: '7', MAX_CLIENTS_PER_SESSION: '3', MESSAGE_RATE_PER_SEC: '5', MESSAGE_BURST: '9' });
    assert.deepEqual(limits, { maxConnections: 50, maxSessions: 7, maxClientsPerSession: 3, messageRatePerSec: 5, messageBurst: 9 });
});

test('loadLimits ignores garbage, zero, negative and fractional values', () => {
    const limits = loadLimits({ MAX_CONNECTIONS: 'lots', MAX_SESSIONS: '0', MAX_CLIENTS_PER_SESSION: '-4', MESSAGE_RATE_PER_SEC: '1.5', MESSAGE_BURST: '' });
    assert.deepEqual(limits, DEFAULT_LIMITS);
});
