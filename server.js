require('dotenv').config();

const { createServer } = require('./src/app');
const sessionLogger = require('./src/session-logger');
const broadcast = require('./src/broadcast');

console.log("I run!");

(async () => {
    const port = process.env.PORT || 3000;
    const { server, sessionStore, protocol } = await createServer();

    let shuttingDown = false;
    async function shutdown(signal, exitCode = 0) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Received ${signal}. Logging ${sessionStore.count()} open session(s) before exit.`);
        // Last-resort insurance: if the flush below hangs, don't leave the
        // process alive-but-unresponsive on an unattended box.
        const forceExitTimer = setTimeout(() => process.exit(exitCode), 5000);

        sessionStore.dissolveAll('serverShutdown').forEach(({ sockets, summary }) => {
            try {
                // Distinct from sessionDissolved: tells clients the *server* is
                // going away, not that their session specifically ended, so the
                // component can show a "server unavailable" message instead of
                // "session ended".
                broadcast.closeWithMessage(sockets, protocol.build('serverShutdown'));
            } catch (err) {
                // A failure notifying this one session (e.g. a stale vendored
                // protocol module missing this message) must not abort the
                // rest of shutdown — still close its sockets and keep logging
                // every other session instead of falling through to the 5s
                // force-exit timer for all of them.
                console.error(`shutdown: failed to notify session ${summary.sessionId}, closing its sockets without a message:`, err);
                sockets.forEach((ws) => ws.close());
            }
            sessionLogger.logSessionTerminated(summary);
        });
        try {
            await sessionLogger.close();
        } catch (err) {
            console.error('session-logger: failed to flush on shutdown:', err);
        }
        clearTimeout(forceExitTimer);
        process.exit(exitCode);
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Last-resort net: something truly unexpected slipped past every
    // targeted guard elsewhere. State may be corrupted at this point, so the
    // safest move is to log, try to shut down cleanly, and exit — relying on
    // the deploy's restart policy to bring the process back up.
    process.on('uncaughtException', (err) => {
        console.error('FATAL uncaughtException:', err);
        shutdown('uncaughtException', 1);
    });
    process.on('unhandledRejection', (reason) => {
        console.error('FATAL unhandledRejection:', reason);
        shutdown('unhandledRejection', 1);
    });

    server.listen(port, () => {
        // server.address().port (not the `port` var) so this is correct even
        // when PORT=0 asks the OS to pick a free port.
        console.log(`Server is listening on http://localhost:${server.address().port}`);
    });
})();
