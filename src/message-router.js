const WebSocket = require('ws');

// One handler per protocol.MESSAGES_TO_SERVER entry, keyed by the same
// name. Dispatch iterates the registry (in declaration order) instead of
// hardcoding which wire field ('message' vs 'type') each one uses, so the
// registry stays the single source of truth for both shape and dispatch.
function createMessageRouter({ sessionStore, broadcast, state, protocol }) {
    const handlers = {
        updateClientName(ctx, messageJson) {
            ctx.client.metadata.name = messageJson.clientName ?? 'unknown';
            const sessionData = sessionStore.getSessionData(ctx.sessionId);
            broadcast.broadcastToSession(sessionStore.get(ctx.sessionId), protocol.build('sessionDataUpdated', { sessionData }), ctx.ws);
        },

        removeClient(ctx, messageJson) {
            const target = sessionStore.findClient(ctx.sessionId, messageJson.clientId);
            if (target && target.ws.readyState === WebSocket.OPEN) {
                broadcast.closeWithMessage([target.ws], protocol.build('clientRemoved'));
            }
        },

        // The session is guaranteed to exist here: connection.js only forwards
        // messages after confirming sessionStore.get(sessionId) succeeded.
        dissolveSession(ctx) {
            const sockets = sessionStore.dissolve(ctx.sessionId);
            broadcast.closeWithMessage(sockets, protocol.build('sessionDissolved'));
        },

        updateState(ctx, messageJson) {
            const session = sessionStore.get(ctx.sessionId);
            const ops = state.applyStateUpdate(ctx.client, session, messageJson.payload);
            ops.forEach(({ client, patch }) => broadcast.safeSend(client.ws, protocol.build('syncState', { patch })));
        }
    };

    // In registry declaration order — this order is what gives
    // `message`-channel messages precedence over `type`-channel ones when
    // (hypothetically) both fields were present on the same payload.
    const toServerEntries = Object.entries(protocol.MESSAGES_TO_SERVER);

    // Fail fast at startup if the handler map and the registry drift apart,
    // rather than silently dropping a message in production.
    for (const [name] of toServerEntries) {
        if (!handlers[name]) {
            throw new Error(`message-router: protocol message "${name}" (toServer) has no handler`);
        }
    }
    for (const name of Object.keys(handlers)) {
        if (!protocol.MESSAGES_TO_SERVER[name]) {
            throw new Error(`message-router: handler "${name}" is not a registered toServer protocol message`);
        }
    }

    function handleMessage(ctx, messageJson) {
        for (const [name, def] of toServerEntries) {
            if (messageJson[def.channel] === name) {
                handlers[name](ctx, messageJson);
                return;
            }
        }
        if (messageJson.type) {
            console.warn(`Ignoring unknown message type "${messageJson.type}".`);
        }
    }

    return { handleMessage };
}

module.exports = { createMessageRouter };
