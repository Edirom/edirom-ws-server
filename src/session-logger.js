const fs = require('fs');
const path = require('path');
const rfs = require('rotating-file-stream');

// Fixed path — not configurable, since the only thing that actually matters
// to an operator is which directory to mount (see Dockerfile's VOLUME).
const DEFAULT_LOG_PATH = path.join(__dirname, '..', 'data', 'sessions.log');

// Builds one logger instance writing to `logPath`. Exported (in addition to
// the default instance below) so tests can point a logger at an isolated
// temp file instead of the real one.
function createSessionLogger(logPath = DEFAULT_LOG_PATH) {
    const logDir = path.dirname(logPath);
    const logFilename = path.basename(logPath);

    fs.mkdirSync(logDir, { recursive: true });

    // No `maxFiles`/`maxSize`: rotated files are size-capped individually but
    // never deleted. Restart-safety comes for free from the library itself —
    // on startup it checks the existing file's size (rotating immediately if
    // already over the limit) and always checks candidate rotated names for
    // existence before using them, so a remounted /data directory just gets
    // appended to / continued rather than overwritten.
    const stream = rfs.createStream(logFilename, {
        size: '20M',
        path: logDir,
        encoding: 'utf8'
    });

    // A disk/write failure here shouldn't take down the WS relay itself —
    // session-termination logging is diagnostic, not core functionality.
    stream.on('error', (err) => {
        console.error('session-logger: write stream error:', err);
    });

    // One JSON object per line ("JSON Lines"), so the file stays parseable/
    // greppable a line at a time without ever needing to load the whole file.
    function logSessionTerminated(summary) {
        stream.write(JSON.stringify(summary) + '\n');
    }

    // Flushes any buffered writes and closes the underlying file descriptor.
    // The SIGTERM/SIGINT handler in server.js must await this before the
    // process exits, or the summary for the very session that triggered the
    // shutdown can be lost mid-buffer.
    function close() {
        return new Promise((resolve, reject) => {
            stream.end((err) => (err ? reject(err) : resolve()));
        });
    }

    return { logSessionTerminated, close };
}

module.exports = { ...createSessionLogger(), createSessionLogger };
