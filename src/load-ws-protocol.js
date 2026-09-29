// The server is CommonJS, but the shared protocol module (vendored from the
// edirom-connected-workspace submodule) is a genuine ES module, so it must
// be loaded via dynamic import() rather than require(). This is the single
// place that knows the relative path, so a missing/uninitialized submodule
// fails with a clear message instead of a bare ERR_MODULE_NOT_FOUND.
async function loadProtocol() {
    try {
        return await import('../vendor/edirom-connected-workspace/ws-protocol.js');
    } catch (e) {
        throw new Error('Could not load the protocol module — did you run `git submodule update --init`? ' + e.message);
    }
}

module.exports = { loadProtocol };
