const { v4: uuidv4 } = require('uuid');
const { createDefaultState } = require('./state');

// Control chars, line/paragraph separators and bidi override/isolate marks
// (which can visually reorder surrounding text). Zero-width joiners are kept
// on purpose so emoji sequences survive.
const UNWANTED_CHARS = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]/gu;

// Cleans a client-supplied free-text field (name, device type). Truncates by
// code point, not UTF-16 unit, so an emoji at the cut isn't split in half.
function sanitizeLabel(raw, maxLength, fallback = 'unknown') {
    if (typeof raw !== 'string') return fallback;
    const cleaned = Array.from(raw.replace(UNWANTED_CHARS, '').trim()).slice(0, maxLength).join('').trim();
    return cleaned === '' ? fallback : cleaned;
}

function createClient({ name, deviceType }) {
    return {
        id: uuidv4(),
        ws: null,
        metadata: { name, deviceType },
        state: createDefaultState(),
        // 0 = this client never reported a state (joining alone doesn't count)
        stateUpdatedAt: 0,
        joinedAt: Date.now()
    };
}

module.exports = { createClient, sanitizeLabel };
