const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { loadProtocol } = require('../src/load-ws-protocol');

// Exercises the real server.js entrypoint (not just src/app.js's createServer())
// as a child process, since the shutdown() function that sends this message
// lives entirely inside server.js's IIFE and isn't otherwise reachable from a
// unit test. PORT=0 lets the OS pick a free port; it's read back off stdout.
function startServer() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: path.join(__dirname, '..'),
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

function connectAndJoin(port) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}/?clientName=Alice&deviceType=desktop`);
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
