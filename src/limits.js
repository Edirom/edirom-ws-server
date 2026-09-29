// Resource caps that keep one misbehaving (or malicious) client from taking
// the relay down. Every value can be overridden through an env var; tests
// pass their own (tiny) limits to createServer() instead.
const DEFAULT_LIMITS = {
    maxConnections: 1000,
    maxSessions: 1000,
    maxClientsPerSession: 100,
    // Token bucket: `messageBurst` messages may arrive back to back, then the
    // sustained rate is `messageRatePerSec`.
    messageRatePerSec: 40,
    messageBurst: 80
};

const ENV_VARS = {
    maxConnections: 'MAX_CONNECTIONS',
    maxSessions: 'MAX_SESSIONS',
    maxClientsPerSession: 'MAX_CLIENTS_PER_SESSION',
    messageRatePerSec: 'MESSAGE_RATE_PER_SEC',
    messageBurst: 'MESSAGE_BURST'
};

// Max lengths of the free-text fields a client controls.
const MAX_CLIENT_NAME_LENGTH = 64;
const MAX_DEVICE_TYPE_LENGTH = 32;

// Unset, empty or non-positive-integer values fall back to the default, so a
// typo in .env can never silently disable a limit.
function loadLimits(env = process.env) {
    const limits = { ...DEFAULT_LIMITS };
    for (const [key, envName] of Object.entries(ENV_VARS)) {
        const raw = env[envName];
        if (raw === undefined || raw === '') continue;
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && parsed > 0) {
            limits[key] = parsed;
        } else {
            console.warn(`${envName}="${raw}" is not a positive integer — using default ${DEFAULT_LIMITS[key]}.`);
        }
    }
    return limits;
}

module.exports = { DEFAULT_LIMITS, MAX_CLIENT_NAME_LENGTH, MAX_DEVICE_TYPE_LENGTH, loadLimits };
