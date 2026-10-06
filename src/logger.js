const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const DEFAULT_LEVEL = 'info';

const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// Unknown/garbage values fall back to the default, like limits.js does, so a
// typo in .env can't silently switch logging off (or on at debug).
function parseLevel(raw) {
    const level = String(raw ?? '').trim().toLowerCase();
    return level in LEVELS ? level : DEFAULT_LEVEL;
}

function parseFormat(raw) {
    return String(raw ?? '').trim().toLowerCase() === 'json' ? 'json' : 'pretty';
}

// "2026-10-06 14:03:12" in local time — what a human tailing the console
// wants. The JSON format carries a full ISO-8601 UTC timestamp instead.
function prettyTimestamp(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Error objects don't survive JSON.stringify (no enumerable props), so turn
// them into plain data. Also handles non-Error values thrown/rejected.
function serializeError(err) {
    if (err instanceof Error) {
        const out = { name: err.name, message: err.message, stack: err.stack };
        if (err.code !== undefined) out.code = err.code;
        return out;
    }
    return { message: String(err) };
}

// Renders { key: value } as aligned "key   value" lines. For `detail`
// blocks, e.g. the startup configuration.
function alignRows(rows) {
    const entries = Object.entries(rows);
    const width = Math.max(0, ...entries.map(([key]) => key.length));
    return entries.map(([key, value]) => `${key.padEnd(width)}  ${value}`);
}

// Builds a logger. Everything environment-specific is injectable so tests can
// capture output deterministically.
//
//   log.info(message, fields, { detail, throttle })
//
// - `message`  one self-contained human sentence. The pretty format prints
//              ONLY this (plus `detail` and `err`), so don't rely on `fields`
//              being visible there.
// - `fields`   machine-readable data. Emitted by the JSON format only, as
//              top-level keys, so log aggregators can filter on them. An
//              `err` field is additionally printed in pretty (with its
//              stack at error level only).
// - `detail`   extra human-only lines (string[]), indented under the message
//              in pretty and dropped from JSON, where `fields` carries the
//              same information structured.
// - `throttle` a key. Entries sharing a key are emitted at most once per
//              `throttleMs`; the rest are counted and reported on the next
//              emitted one. For lines a client can trigger at will (limit
//              hits, malformed input) so a flood can't flood the log too.
function createLogger({
    level = DEFAULT_LEVEL,
    format = 'pretty',
    out = process.stdout,
    err = process.stderr,
    color = false,
    throttleMs = 10000,
    now = () => new Date()
} = {}) {
    const threshold = LEVELS[parseLevel(level)];
    const json = parseFormat(format) === 'json';
    const throttled = new Map(); // key -> { lastAt, suppressed }

    function checkThrottle(key) {
        const nowMs = now().getTime();
        const entry = throttled.get(key);
        if (!entry) {
            throttled.set(key, { lastAt: nowMs, suppressed: 0 });
            return { emit: true, suppressed: 0 };
        }
        if (nowMs - entry.lastAt < throttleMs) {
            entry.suppressed += 1;
            return { emit: false, suppressed: 0 };
        }
        const suppressed = entry.suppressed;
        entry.lastAt = nowMs;
        entry.suppressed = 0;
        return { emit: true, suppressed };
    }

    function formatJson(date, lvl, message, fields, suppressed) {
        const record = { time: date.toISOString(), level: lvl, msg: message, ...fields };
        if (record.err !== undefined) record.err = serializeError(record.err);
        if (suppressed > 0) record.suppressed = suppressed;
        return JSON.stringify(record);
    }

    const paint = (code, text) => (color ? `${code}${text}${RESET}` : text);

    function formatPretty(date, lvl, message, fields, detail, suppressed) {
        const time = prettyTimestamp(date);
        const label = lvl.toUpperCase().padEnd(5);
        // Continuation lines (detail, stack) line up under the message text.
        const indent = ' '.repeat(time.length + 2 + label.length + 2);
        const suffix = suppressed > 0 ? paint(DIM, ` (+${suppressed} similar suppressed)`) : '';

        const lines = [`${paint(DIM, time)}  ${paint(COLORS[lvl], label)}  ${message}${suffix}`];
        for (const line of detail) lines.push(`${indent}${paint(DIM, line)}`);
        if (fields.err !== undefined) {
            const { name, message: errMessage, stack } = serializeError(fields.err);
            // The stack's first line repeats name+message; keep only the frames.
            // Warnings are expected trouble (a dropped client, a bad input), so
            // they get the one-line message; stacks are for real errors.
            const frames = stack && lvl === 'error' ? stack.split('\n').slice(1).map((l) => l.trim()).filter(Boolean) : [];
            lines.push(`${indent}${paint(COLORS[lvl], `${name ? `${name}: ` : ''}${errMessage}`)}`);
            for (const frame of frames) lines.push(`${indent}${paint(DIM, `  ${frame}`)}`);
        }
        return lines.join('\n');
    }

    function write(lvl, message, fields = {}, { detail = [], throttle } = {}) {
        if (LEVELS[lvl] < threshold) return;
        let suppressed = 0;
        if (throttle !== undefined) {
            const decision = checkThrottle(`${lvl}:${throttle}`);
            if (!decision.emit) return;
            suppressed = decision.suppressed;
        }
        const date = now();
        const line = json
            ? formatJson(date, lvl, message, fields, suppressed)
            : formatPretty(date, lvl, message, fields, detail, suppressed);
        // Operational noise to stdout, problems to stderr (the usual split,
        // and what `docker logs` / systemd label as such).
        (LEVELS[lvl] >= LEVELS.warn ? err : out).write(line + '\n');
    }

    // The startup banner. Human decoration, so it's skipped for JSON where
    // every stdout line must be a parseable record.
    function banner(title) {
        if (json || LEVELS.info < threshold) return;
        const text = `### ${title} ###`;
        const border = '#'.repeat(text.length);
        out.write(paint(COLORS.info, `${border}\n${text}\n${border}`) + '\n');
    }

    return {
        debug: (message, fields, options) => write('debug', message, fields, options),
        info: (message, fields, options) => write('info', message, fields, options),
        warn: (message, fields, options) => write('warn', message, fields, options),
        error: (message, fields, options) => write('error', message, fields, options),
        banner,
        level: parseLevel(level),
        format: json ? 'json' : 'pretty',
        isLevelEnabled: (lvl) => LEVELS[lvl] >= threshold
    };
}

// Colour only for an interactive terminal; honours the NO_COLOR convention
// (https://no-color.org) and FORCE_COLOR for e.g. `docker run -t`-less CI.
function shouldUseColor(env, stream) {
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
    if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
    return Boolean(stream.isTTY);
}

function createLoggerFromEnv(env = process.env) {
    return createLogger({
        level: env.LOG_LEVEL,
        format: env.LOG_FORMAT,
        color: shouldUseColor(env, process.stdout)
    });
}

// Default instance, configured once from the environment. server.js loads
// dotenv before requiring anything under src/, so .env values are visible here.
module.exports = { ...createLoggerFromEnv(), createLogger, createLoggerFromEnv, alignRows, parseLevel, parseFormat };
