const WebSocket = require('ws');

// Two dispatch tables, matching the two conventions real clients already
// use: `message` for imperative commands, `type` for the state-sync
// protocol. Not unified into one shape — that would be a wire change.
function createMessageRouter({ sessionStore, broadcast, state }) {
    const commandHandlers = {
        updateClientName(ctx, messageJson) {
            ctx.client.metadata.name = messageJson.clientName ?? 'unknown';
            const sessionData = sessionStore.getSessionData(ctx.sessionId);
            broadcast.broadcastToSession(sessionStore.get(ctx.sessionId), { response: 'sessionDataUpdated', sessionData }, ctx.ws);
        },

        removeClient(ctx, messageJson) {
            const target = sessionStore.findClient(ctx.sessionId, messageJson.clientId);
            if (target && target.ws.readyState === WebSocket.OPEN) {
                broadcast.closeWithMessage([target.ws], { response: 'clientRemoved' });
            }
        },

        // The session is guaranteed to exist here: connection.js only forwards
        // messages after confirming sessionStore.get(sessionId) succeeded.
        dissolveSession(ctx) {
            const sockets = sessionStore.dissolve(ctx.sessionId);
            broadcast.closeWithMessage(sockets, { response: 'sessionDissolved' });
        }
    };

    const typeHandlers = {
        updateState(ctx, messageJson) {
            const session = sessionStore.get(ctx.sessionId);
            const ops = state.applyStateUpdate(ctx.client, session, messageJson.payload);
            ops.forEach(({ client, patch }) => broadcast.sendSyncState(client, patch));
        }
    };

    function handleMessage(ctx, messageJson) {
        if (messageJson.message && commandHandlers[messageJson.message]) {
            commandHandlers[messageJson.message](ctx, messageJson);
        } else if (messageJson.type) {
            if (typeHandlers[messageJson.type]) {
                typeHandlers[messageJson.type](ctx, messageJson);
            } else {
                console.warn(`Ignoring unknown message type "${messageJson.type}".`);
            }
        }
    }

    return { handleMessage };
}

module.exports = { createMessageRouter };
