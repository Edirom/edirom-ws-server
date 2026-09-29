// Token bucket: holds up to `burst` tokens and refills at `ratePerSec`.
// take() consumes one token and returns false once the bucket is empty.
// `now` is injectable so tests can drive time without sleeping.
function createTokenBucket({ ratePerSec, burst, now = Date.now }) {
    let tokens = burst;
    let last = now();

    function take() {
        const current = now();
        tokens = Math.min(burst, tokens + ((current - last) / 1000) * ratePerSec);
        last = current;
        if (tokens < 1) return false;
        tokens -= 1;
        return true;
    }

    return { take };
}

module.exports = { createTokenBucket };
