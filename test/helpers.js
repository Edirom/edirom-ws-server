const WebSocket = require('ws');
const { loadProtocol } = require('../src/load-ws-protocol');

let protocolPromise;
const getProtocol = () => (protocolPromise ??= loadProtocol());

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, () => resolve(server.address().port));
    });
}

// Adds the current protocolVersion to a hand-written query string, since the
// server rejects connections without a matching one. Pass
// `protocolVersion: null` to omit it, or a value to send a specific one.
async function buildUrl(port, query = '', { protocolVersion } = {}) {
    const protocol = await getProtocol();
    const url = new URL(query || '/', 'http://localhost');
    const version = protocolVersion === undefined ? protocol.PROTOCOL_VERSION : protocolVersion;
    if (version !== null && !url.searchParams.has(protocol.CONNECT_PARAMS.protocolVersion)) {
        url.searchParams.set(protocol.CONNECT_PARAMS.protocolVersion, version);
    }
    return `ws://localhost:${port}${url.pathname}${url.search}`;
}

// Buffers incoming messages from the moment the socket is created, so a
// message the server sends before the test calls next() is never missed.
async function connectClient(port, query = '', options) {
    const ws = new WebSocket(await buildUrl(port, query, options));
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

module.exports = { listen, buildUrl, connectClient, getProtocol };
