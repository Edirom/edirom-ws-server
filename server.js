// quiet: dotenv otherwise prints its own banner line into the log.
require('dotenv').config({ quiet: true });

const { createServer } = require('./src/app');
const sessionLogger = require('./src/session-logger');
const broadcast = require('./src/broadcast');
const log = require('./src/logger');
const { alignRows } = log;
const { createActivityLog, plural } = require('./src/activity-log');
const { version } = require('./package.json');

log.banner('EDIROM WEB SOCKET SERVER');

(async () => {
    const port = process.env.PORT || 3000;
    const { server, sessionStore, protocol, limits } = await createServer();
    const activity = createActivityLog({ sessionStore });

    let shuttingDown = false;
    async function shutdown(signal, exitCode = 0) {
        if (shuttingDown) return;
        shuttingDown = true;
        const openSessions = sessionStore.count();
        activity.event(`Received ${signal}, shutting down (closing ${plural(openSessions, 'open session')})`, { event: 'shutdown', signal, exitCode });
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
                log.error(`Failed to notify session ${summary.sessionId} of shutdown, closing its sockets without a message`, { err, sessionId: summary.sessionId });
                sockets.forEach((ws) => ws.close());
            }
            sessionLogger.logSessionTerminated(summary);
        });
        try {
            await sessionLogger.close();
        } catch (err) {
            log.error('Failed to flush the session log on shutdown', { err });
        }
        clearTimeout(forceExitTimer);
        log.info('Shutdown complete');
        process.exit(exitCode);
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Last-resort net: something truly unexpected slipped past every
    // targeted guard elsewhere. State may be corrupted at this point, so the
    // safest move is to log, try to shut down cleanly, and exit — relying on
    // the deploy's restart policy to bring the process back up.
    process.on('uncaughtException', (err) => {
        log.error('FATAL uncaught exception', { err });
        shutdown('uncaughtException', 1);
    });
    process.on('unhandledRejection', (reason) => {
        log.error('FATAL unhandled promise rejection', { err: reason });
        shutdown('unhandledRejection', 1);
    });

    server.listen(port, () => {
        // server.address().port (not the `port` var) so this is correct even
        // when PORT=0 asks the OS to pick a free port.
        const actualPort = server.address().port;
        const debugEnabled = Boolean(process.env.DEBUG_TOKEN);
        const config = {
            version,
            node: process.version,
            pid: process.pid,
            port: actualPort,
            protocolVersion: protocol.PROTOCOL_VERSION,
            logLevel: log.level,
            logFormat: log.format,
            debugEndpoint: debugEnabled,
            sessionLog: sessionLogger.logPath
        };
        log.info(`Server started, listening on http://localhost:${actualPort}`, { event: 'server_started', ...config, limits }, {
            detail: alignRows({
                Version: version,
                Node: process.version,
                PID: process.pid,
                Protocol: protocol.PROTOCOL_VERSION,
                Limits: `${limits.maxConnections} connections, ${limits.maxSessions} sessions, ${limits.maxClientsPerSession} clients/session, ${limits.messageRatePerSec} msg/s (burst ${limits.messageBurst})`,
                'Debug API': debugEnabled ? 'enabled at /debug/sessions' : 'disabled (set DEBUG_TOKEN to enable)',
                'Session log': sessionLogger.logPath,
                Logging: `level ${config.logLevel}, format ${config.logFormat}`
            })
        });
    });
})().catch((err) => {
    // Startup itself failed (e.g. the protocol submodule is missing) — before
    // any of the handlers above exist, so report it ourselves.
    log.error('FATAL failed to start', { err });
    process.exit(1);
});
