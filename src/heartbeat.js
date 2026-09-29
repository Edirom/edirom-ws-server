// Reaps connections that stop responding to WebSocket protocol-level pings —
// e.g. a client's network drops without a clean TCP close, which would
// otherwise leave a ghost client (and its session) in memory indefinitely.
// wss.clients already contains every upgraded socket regardless of whether
// 'connection' is ever emitted (see websocket-server.js's completeUpgrade),
// so no extra bookkeeping is needed to populate it.
function sweep(wss) {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        ws.ping();
    });
}

function startHeartbeat(wss, intervalMs = 30000) {
    const interval = setInterval(() => sweep(wss), intervalMs);
    // The listening server itself already keeps the process alive in
    // production; unref'ing here only matters for tests/shutdown paths where
    // not every socket gets an explicit close, so this timer alone should
    // never be what keeps the process running.
    interval.unref();
    return () => clearInterval(interval);
}

module.exports = { startHeartbeat, sweep };
