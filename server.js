require('dotenv').config();

const { createServer } = require('./src/app');
const sessionLogger = require('./src/session-logger');

console.log("I run!");

(async () => {
    const port = process.env.PORT || 3000;
    const { server, sessionStore } = await createServer();

    let shuttingDown = false;
    async function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Received ${signal}. Logging ${sessionStore.count()} open session(s) before exit.`);
        sessionStore.dissolveAll('serverShutdown').forEach(summary => sessionLogger.logSessionTerminated(summary));
        try {
            await sessionLogger.close();
        } catch (err) {
            console.error('session-logger: failed to flush on shutdown:', err);
        }
        process.exit(0);
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    server.listen(port, () => {
        console.log(`Server is listening on http://localhost:${port}`);
    });
})();
