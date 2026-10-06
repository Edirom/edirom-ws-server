const defaultLogger = require('./logger');

// How many sessions the console summary lists before collapsing the rest into
// "… and N more", so a busy server doesn't print a wall of text per event.
const MAX_LISTED_SESSIONS = 10;

// 90 -> "1m 30s", 3_900_000 -> "1h 5m", 500 -> "<1s".
function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 1) return '<1s';
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = days > 0 ? [`${days}d`, `${hours}h`]
        : hours > 0 ? [`${hours}h`, `${minutes}m`]
        : minutes > 0 ? [`${minutes}m`, `${seconds}s`]
        : [`${seconds}s`];
    return parts.join(' ');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "Bob (mobile)" — what a human recognises. The id is cut to 8 characters:
// enough to tell clients apart in a log, short enough to not drown the line.
function describeClient(client) {
    const { name, deviceType } = client.metadata ?? {};
    return `${name ?? 'unknown'} (${deviceType ?? 'unknown'})`;
}

const shortId = (id) => String(id).slice(0, 8);

// Builds the summary of the server's current state, both as human lines
//   Now 20 connections in 7 sessions:
//     K7M2QX  3 connections  open 10m 4s      (oldest first, capped)
// and as the structured fields the JSON format carries.
function summarize(overview, now = Date.now()) {
    const { connections, sessions } = overview;
    const listed = sessions.slice(0, MAX_LISTED_SESSIONS);
    const labels = listed.map((s) => plural(s.connections, 'connection'));
    const width = Math.max(0, ...labels.map((label) => label.length));

    const lines = [`Now ${plural(connections, 'connection')} in ${plural(sessions.length, 'session')}${listed.length > 0 ? ':' : ''}`];
    listed.forEach((s, i) => lines.push(`  ${s.sessionId}  ${labels[i].padEnd(width)}  open ${formatDuration(now - s.createdAt)}`));
    if (sessions.length > listed.length) lines.push(`  … and ${sessions.length - listed.length} more`);

    return {
        lines,
        fields: {
            connections,
            sessions: sessions.length,
            sessionList: sessions.map((s) => ({ sessionId: s.sessionId, connections: s.connections, ageMs: now - s.createdAt }))
        }
    };
}

// The one place that turns "something happened to a session" into console
// output: connect, join, leave, end, dissolve and shutdown all go through
// event(), so each of them reports the same trailing state summary without
// repeating the logic.
//
//   activity.event('Bob (mobile) joined session K7M2QX', { event: 'session_joined', sessionId })
function createActivityLog({ sessionStore, log = defaultLogger, now = Date.now }) {
    function event(message, fields = {}, level = 'info') {
        const summary = summarize(sessionStore.overview(), now());
        log[level](message, { ...fields, ...summary.fields }, { detail: summary.lines });
    }
    return { event };
}

module.exports = { createActivityLog, summarize, formatDuration, describeClient, shortId, plural, MAX_LISTED_SESSIONS };
