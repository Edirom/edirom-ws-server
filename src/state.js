const log = require('./logger');

// ---------------------------------------------------------------------------
// Client state
//
// Every client entry carries a `state` object describing what that client is
// currently showing. Clients report changes with `updateState`; the server
// orchestrates other clients with `syncState`.
//
// STATE_SCHEMA is the single place that defines which keys exist:
//   default   value a fresh client starts with
//   shared    true  → a change is propagated to the other clients in the session
//             false → only stored (e.g. a future per-client "openWindows")
//   validate  returns true for acceptable values; anything else is dropped
//
// Adding a new state key means adding one entry here.
//
// Nothing in this module touches a WebSocket. Functions here take/return
// plain data (client/session objects, patches) so they can be unit-tested
// without opening a socket; callers are responsible for actually sending
// anything this module reports as changed.
// ---------------------------------------------------------------------------
const isNullableId = (value) => value === null || (typeof value === 'string' && value.length <= 256);

const STATE_SCHEMA = {
    edition: { default: null, shared: true, validate: isNullableId },
    work: { default: null, shared: true, validate: isNullableId },
    // ID of the selected concordance connection; null = none selected / free exploration
    connection: { default: null, shared: true, validate: isNullableId }
};

function createDefaultState() {
    return Object.fromEntries(Object.entries(STATE_SCHEMA).map(([key, def]) => [key, def.default]));
}

// Keeps only known keys with valid values from a client-supplied patch.
function sanitizeStatePatch(patch) {
    const clean = {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clean;
    for (const [key, value] of Object.entries(patch)) {
        const def = STATE_SCHEMA[key];
        if (!def) {
            log.warn(`Ignored unknown state key ${JSON.stringify(key.slice(0, 50))}`, {}, { throttle: 'state-unknown-key' });
        } else if (!def.validate(value)) {
            log.warn(`Ignored invalid value for state key ${JSON.stringify(key)}`, {}, { throttle: 'state-invalid-value' });
        } else {
            clean[key] = value;
        }
    }
    return clean;
}

function getSharedState(state) {
    return Object.fromEntries(Object.keys(STATE_SCHEMA).filter(key => STATE_SCHEMA[key].shared).map(key => [key, state[key]]));
}

/**
 * Gives a joining client the current shared state of the session.
 * The reference is the member that reported a state most recently (ties and
 * "nobody reported yet" fall back to the oldest member).
 * @returns {Object} The patch to send to the joiner as its initial `syncState`.
 *   Empty if no member has reported a state yet, so nobody gets reset to defaults.
 */
function adoptSessionState(joiningClient, existingClients) {
    if (existingClients.length === 0) return {};
    const reference = existingClients.reduce((newest, c) => c.stateUpdatedAt > newest.stateUpdatedAt ? c : newest);
    if (reference.stateUpdatedAt === 0) return {};
    const patch = getSharedState(reference.state);
    Object.assign(joiningClient.state, patch);
    return patch;
}

/**
 * Handles a client's `updateState` message ("my state changed").
 *
 * payload: { patch: { <key>: <value>, … }, cause?: "user" | "syncResult" }
 *
 * - Keys/values that are unknown or invalid are dropped.
 * - A patch that changes nothing is ignored.
 * - "user" changes to shared keys are applied to every other client that
 *   doesn't have that value yet, and returned as one sync op per client for
 *   the caller to actually send.
 * - "syncResult" is a client reporting what it actually ended up with after a
 *   `syncState`. It only corrects the sender's own entry and is never fanned
 *   out, so a failed apply can't bounce between clients.
 *
 * @returns {Array<{client, patch}>} sync ops the caller should send via `syncState`.
 */
function applyStateUpdate(sender, session, payload) {
    const patch = sanitizeStatePatch(payload?.patch);
    const changedKeys = Object.keys(patch).filter(key => sender.state[key] !== patch[key]);
    if (changedKeys.length === 0) return [];

    changedKeys.forEach(key => { sender.state[key] = patch[key]; });
    sender.stateUpdatedAt = Date.now();
    log.debug(`State of client ${sender.id} updated: ${JSON.stringify(Object.fromEntries(changedKeys.map(key => [key, patch[key]])))}`);

    if (payload?.cause === 'syncResult') return [];

    const changedSharedKeys = changedKeys.filter(key => STATE_SCHEMA[key].shared);
    if (changedSharedKeys.length === 0) return [];

    const ops = [];
    session.clients.forEach(other => {
        if (other === sender) return;
        const otherPatch = {};
        changedSharedKeys.forEach(key => {
            if (other.state[key] !== patch[key]) otherPatch[key] = patch[key];
        });
        if (Object.keys(otherPatch).length === 0) return;
        Object.assign(other.state, otherPatch);
        ops.push({ client: other, patch: otherPatch });
    });
    return ops;
}

module.exports = {
    STATE_SCHEMA,
    createDefaultState,
    sanitizeStatePatch,
    getSharedState,
    adoptSessionState,
    applyStateUpdate
};
