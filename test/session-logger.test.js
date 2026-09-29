const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionLogger } = require('../src/session-logger');

test('logSessionTerminated() writes one JSON line per call; close() flushes it to disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-logger-test-'));
    const logPath = path.join(dir, 'sessions.log');
    const sessionLogger = createSessionLogger(logPath);

    const summary = { event: 'session_terminated', sessionId: 'ABC123', reason: 'explicitDissolve' };
    sessionLogger.logSessionTerminated(summary);
    await sessionLogger.close();

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), summary);

    fs.rmSync(dir, { recursive: true, force: true });
});

test('logSessionTerminated() creates the target directory if it does not exist yet', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-logger-test-'));
    const logPath = path.join(dir, 'nested', 'sessions.log');
    const sessionLogger = createSessionLogger(logPath);

    sessionLogger.logSessionTerminated({ event: 'session_terminated', sessionId: 'XYZ789' });
    await sessionLogger.close();

    assert.ok(fs.existsSync(logPath));
    fs.rmSync(dir, { recursive: true, force: true });
});
