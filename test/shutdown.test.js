const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { loadProtocol } = require('../src/load-ws-protocol');
const { buildUrl } = require('./helpers');

// Exercises the real server.js entrypoint (not just src/app.js's createServer())
// as a child process, since the shutdown() function that sends this message
// lives entirely inside server.js's IIFE and isn't otherwise reachable from a
// unit test. PORT=0 lets the OS pick a free port; it's read back off stdout.
// `cwd` defaults to the real repo but can point at a rigged copy (see
// buildServerCopyWithoutServerShutdown below) to simulate deployment drift.
function startServer({ cwd = path.join(__dirname, '..') } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd,
            env: { ...process.env, PORT: '0' }
        });
        let output = '';
        const onData = (chunk) => {
            output += chunk.toString();
            const match = output.match(/Server is listening on http:\/\/localhost:(\d+)/);
            if (match) {
                child.stdout.off('data', onData);
                resolve({ child, port: Number(match[1]) });
            }
        };
        child.stdout.on('data', onData);
        child.once('error', reject);
        child.once('exit', (code) => {
            if (code !== null && code !== 0) reject(new Error(`server.js exited early with code ${code}:\n${output}`));
        });
    });
}

// Regression fixture for the real incident this reproduces: a deployed
// server.js newer than its vendored ws-protocol.js submodule (the submodule
// bump didn't make it into the build), so protocol.build('serverShutdown')
// throws "Unknown protocol message". Copies the real repo into a temp dir
// and strips the serverShutdown entry back out of the vendored protocol file
// to simulate that stale state, without touching the actual submodule.
function buildServerCopyWithoutServerShutdown() {
    const repoRoot = path.join(__dirname, '..');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-server-stale-protocol-'));
    for (const entry of ['server.js', 'src', 'vendor']) {
        fs.cpSync(path.join(repoRoot, entry), path.join(dir, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'));

    const protocolPath = path.join(dir, 'vendor/edirom-connected-workspace/ws-protocol.js');
    const withServerShutdown = fs.readFileSync(protocolPath, 'utf8');
    const withoutServerShutdown = withServerShutdown.replace(
        /\n\s*\/\/ Sent to every connected client right before the server process itself[\s\S]*?serverShutdown: \{\s*channel: 'response',\s*build: \(\) => \(\{ response: 'serverShutdown' \}\)\s*\},/,
        ''
    );
    assert.notEqual(withoutServerShutdown, withServerShutdown, 'fixture setup failed: serverShutdown entry was not found/stripped');
    fs.writeFileSync(protocolPath, withoutServerShutdown);

    return dir;
}

async function connectAndJoin(port) {
    const url = await buildUrl(port, '/?clientName=Alice&deviceType=desktop');
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const messages = [];
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            messages.push(msg);
            if (msg.response === 'sessionJoined') resolve({ ws, messages });
        });
        ws.once('error', reject);
    });
}

test('SIGTERM notifies connected clients with serverShutdown before closing them', async () => {
    const protocol = await loadProtocol();
    const { child, port } = await startServer();
    try {
        const { ws, messages } = await connectAndJoin(port);

        const closed = new Promise((resolve) => ws.once('close', resolve));
        child.kill('SIGTERM');
        await closed;

        assert.ok(
            messages.some((m) => protocol.matches(m, 'serverShutdown')),
            `expected a serverShutdown message, got: ${JSON.stringify(messages)}`
        );

        const exitCode = await new Promise((resolve) => child.once('exit', resolve));
        assert.equal(exitCode, 0);
    } finally {
        if (!child.killed) child.kill('SIGKILL');
    }
});

test('shutdown survives a stale vendored protocol module missing serverShutdown', async () => {
    const dir = buildServerCopyWithoutServerShutdown();
    const { child, port } = await startServer({ cwd: dir });
    try {
        const { ws } = await connectAndJoin(port);

        const closed = new Promise((resolve) => ws.once('close', resolve));
        child.kill('SIGTERM');
        // The socket must still close (even without a serverShutdown message)
        // instead of being left open while the server exits.
        await closed;

        const exitCode = await new Promise((resolve) => child.once('exit', resolve));
        // Exit code 0: the SIGTERM path (exitCode defaults to 0), not the
        // uncaughtException/unhandledRejection path (which would exit 1) —
        // proves the error was caught inline, not escaped and re-caught by
        // the last-resort net.
        assert.equal(exitCode, 0);
    } finally {
        if (!child.killed) child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
