const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../src/logger');
const { createActivityLog, summarize, formatDuration, MAX_LISTED_SESSIONS } = require('../src/activity-log');

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

test('formatDuration uses the two most significant units', () => {
    assert.equal(formatDuration(400), '<1s');
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(90_000), '1m 30s');
    assert.equal(formatDuration(3_900_000), '1h 5m');
    assert.equal(formatDuration(90_000_000), '1d 1h');
});

test('summarize builds a headline plus one aligned line per session, singular/plural aware', () => {
    const { lines, fields } = summarize({
        connections: 4,
        sessions: [
            { sessionId: 'AAAAAA', connections: 3, createdAt: NOW - 600_000 },
            { sessionId: 'BBBBBB', connections: 1, createdAt: NOW - 30_000 }
        ]
    }, NOW);
    assert.deepEqual(lines, [
        'Now 4 connections in 2 sessions:',
        '  AAAAAA  3 connections  open 10m 0s',
        '  BBBBBB  1 connection   open 30s'
    ]);
    assert.equal(fields.connections, 4);
    assert.equal(fields.sessions, 2);
    assert.deepEqual(fields.sessionList[1], { sessionId: 'BBBBBB', connections: 1, ageMs: 30_000 });
});

test('summarize has no trailing colon when there are no sessions', () => {
    assert.deepEqual(summarize({ connections: 0, sessions: [] }, NOW).lines, ['Now 0 connections in 0 sessions']);
});

test('summarize collapses sessions beyond the cap but keeps the full structured list', () => {
    const sessions = Array.from({ length: MAX_LISTED_SESSIONS + 3 }, (_, i) => ({ sessionId: `S${i}`, connections: 1, createdAt: NOW }));
    const { lines, fields } = summarize({ connections: sessions.length, sessions }, NOW);
    assert.equal(lines.length, 1 + MAX_LISTED_SESSIONS + 1);
    assert.equal(lines.at(-1), '  … and 3 more');
    assert.equal(fields.sessionList.length, sessions.length);
});

test('event() logs the message once with the current overview attached', () => {
    const out = [];
    const log = createLogger({ out: { write: (l) => out.push(l) }, err: { write: () => {} }, format: 'json' });
    const sessionStore = { overview: () => ({ connections: 2, sessions: [{ sessionId: 'AAAAAA', connections: 2, createdAt: NOW - 1000 }] }) };
    const activity = createActivityLog({ sessionStore, log, now: () => NOW });

    activity.event('Bob joined', { event: 'session_joined' });

    const record = JSON.parse(out[0]);
    assert.equal(record.msg, 'Bob joined');
    assert.equal(record.event, 'session_joined');
    assert.equal(record.connections, 2);
    assert.equal(record.sessions, 1);
});
