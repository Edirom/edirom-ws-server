const os = require('os');
const WebSocket = require('ws');

// Generates a unique 6-character alphanumeric session ID (uppercase, unambiguous charset)
function generateSessionId(sessions) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id;
    do {
        id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (sessions[id]);
    return id;
}

// A roster entry tracks one member's full membership in a session — unlike
// the `clients` array (which only holds who's *currently* connected), a
// roster entry survives that member leaving, so a session-termination
// summary can report on everyone who was ever part of the session.
function makeRosterEntry(client, joinOrder) {
    return {
        id: client.id,
        name: client.metadata?.name,
        deviceType: client.metadata?.deviceType,
        joinedAt: client.joinedAt,
        joinOrder,
        leftAt: null,
        leaveOrder: null
    };
}

// Pure: builds the structured record logged when a session ends. Takes the
// session object as it stood right before deletion, so it can be called from
// dissolve()/removeClient() (a member still connected at that moment, e.g.
// via an explicit dissolve or a server shutdown, is recorded as leaving at
// `terminatedAt`) and unit-tested without a session store or sockets.
function buildTerminationSummary(session, sessionId, reason, terminatedAt) {
    let leaveCounter = session.leaveCounter;
    const members = session.roster.map(entry => {
        const stillOpen = entry.leftAt === null;
        const leftAt = stillOpen ? terminatedAt : entry.leftAt;
        const leaveOrder = stillOpen ? ++leaveCounter : entry.leaveOrder;
        return {
            id: entry.id,
            name: entry.name,
            deviceType: entry.deviceType,
            joinedAt: new Date(entry.joinedAt).toISOString(),
            leftAt: new Date(leftAt).toISOString(),
            durationMs: leftAt - entry.joinedAt,
            joinOrder: entry.joinOrder,
            leaveOrder
        };
    });

    return {
        event: 'session_terminated',
        sessionId,
        reason,
        hostname: os.hostname(),
        createdAt: new Date(session.createdAt).toISOString(),
        terminatedAt: new Date(terminatedAt).toISOString(),
        durationMs: terminatedAt - session.createdAt,
        peakConcurrentMembers: session.peakConcurrentMembers,
        members
    };
}

// Owns the in-memory sessions map. Never sends/closes a socket itself —
// dissolve()/removeClient() return data for the caller to act on, so this
// stays testable with plain fake socket objects.
function createSessionStore() {
    const sessions = {};

    function create(client) {
        const sessionId = generateSessionId(sessions);
        sessions[sessionId] = {
            createdAt: Date.now(),
            clients: [client],
            roster: [makeRosterEntry(client, 1)],
            peakConcurrentMembers: 1,
            leaveCounter: 0
        };
        return sessionId;
    }

    function get(sessionId) {
        return sessions[sessionId];
    }

    function addClient(sessionId, client) {
        const session = sessions[sessionId];
        session.clients.push(client);
        session.roster.push(makeRosterEntry(client, session.roster.length + 1));
        session.peakConcurrentMembers = Math.max(session.peakConcurrentMembers, session.clients.length);
    }

    // Returns the termination summary if removing this client just emptied
    // (and therefore deleted) the session, otherwise null.
    function removeClient(ws, sessionId) {
        const session = sessions[sessionId];
        if (!session) return null;

        const leavingClient = session.clients.find(c => c.ws === ws);
        session.clients = session.clients.filter(c => c.ws !== ws);

        if (leavingClient) {
            const rosterEntry = session.roster.find(r => r.id === leavingClient.id && r.leftAt === null);
            if (rosterEntry) {
                session.leaveCounter += 1;
                rosterEntry.leftAt = Date.now();
                rosterEntry.leaveOrder = session.leaveCounter;
            }
        }

        if (session.clients.length === 0) {
            const summary = buildTerminationSummary(session, sessionId, 'allMembersLeft', Date.now());
            delete sessions[sessionId];
            return summary;
        }
        return null;
    }

    function findClient(sessionId, clientId) {
        return sessions[sessionId]?.clients.find(c => c.id === clientId);
    }

    function getSessionData(sessionId) {
        if (!sessionId || !sessions[sessionId]) return { sessionMembers: [] };
        const sessionMembers = sessions[sessionId].clients.map(c => ({ id: c.id, metadata: c.metadata }));
        return { sessionMembers };
    }

    // Returns the sockets that were open at the time of dissolving (for the
    // caller to notify and close) plus the termination summary; the session
    // itself is already gone by the time this returns.
    function dissolve(sessionId) {
        const session = sessions[sessionId];
        if (!session) return { sockets: [], summary: null };

        const socketsToClose = session.clients
            .map(c => c.ws)
            .filter(socket => socket && socket.readyState === WebSocket.OPEN);

        const summary = buildTerminationSummary(session, sessionId, 'explicitDissolve', Date.now());

        delete sessions[sessionId];

        return { sockets: socketsToClose, summary };
    }

    function count() {
        return Object.keys(sessions).length;
    }

    // Terminates every still-open session at once (server shutdown) and
    // returns, per session, the sockets to notify+close plus the termination
    // summary to log — same shape as dissolve(), so the caller can't silently
    // drop connected clients the way a summary-only return would invite.
    function dissolveAll(reason) {
        const now = Date.now();
        const results = Object.entries(sessions).map(([sessionId, session]) => {
            const sockets = session.clients
                .map(c => c.ws)
                .filter(socket => socket && socket.readyState === WebSocket.OPEN);
            const summary = buildTerminationSummary(session, sessionId, reason, now);
            return { sockets, summary };
        });
        Object.keys(sessions).forEach(sessionId => delete sessions[sessionId]);
        return results;
    }

    // Lightweight counts for the console log: no member details, nothing a
    // client controls. Oldest session first, so the list reads stably.
    function overview() {
        const list = Object.entries(sessions)
            .map(([sessionId, session]) => ({ sessionId, connections: session.clients.length, createdAt: session.createdAt }))
            .sort((a, b) => a.createdAt - b.createdAt);
        return { connections: list.reduce((sum, s) => sum + s.connections, 0), sessions: list };
    }

    // Live snapshot of every session for the debug endpoint — distinct from
    // buildTerminationSummary(), which only fires once a session ends.
    function listSessions() {
        const now = Date.now();
        return Object.entries(sessions).map(([sessionId, session]) => ({
            sessionId,
            createdAt: new Date(session.createdAt).toISOString(),
            peakConcurrentMembers: session.peakConcurrentMembers,
            members: session.clients.map(c => ({
                id: c.id,
                name: c.metadata?.name,
                deviceType: c.metadata?.deviceType,
                joinedAt: new Date(c.joinedAt).toISOString(),
                connectedForMs: now - c.joinedAt,
                state: c.state
            }))
        }));
    }

    return { create, get, addClient, removeClient, findClient, getSessionData, dissolve, dissolveAll, count, overview, listSessions };
}

module.exports = { createSessionStore, buildTerminationSummary };
