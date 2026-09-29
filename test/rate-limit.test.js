const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenBucket } = require('../src/rate-limit');

function fakeClock(start = 0) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => { t += ms; };
    return now;
}

test('token bucket allows a burst, then refuses', () => {
    const now = fakeClock();
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 5, now });
    const results = Array.from({ length: 7 }, () => bucket.take());
    assert.deepEqual(results, [true, true, true, true, true, false, false]);
});

test('token bucket refills at the sustained rate', () => {
    const now = fakeClock();
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 5, now });
    for (let i = 0; i < 5; i++) bucket.take();
    assert.equal(bucket.take(), false);

    now.advance(100); // 10/s → one token per 100ms
    assert.equal(bucket.take(), true);
    assert.equal(bucket.take(), false);
});

test('token bucket never holds more than the burst, however long it idles', () => {
    const now = fakeClock();
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 3, now });
    now.advance(60_000);
    const results = Array.from({ length: 5 }, () => bucket.take());
    assert.deepEqual(results, [true, true, true, false, false]);
});

test('a steady rate at the limit is never refused', () => {
    const now = fakeClock();
    const bucket = createTokenBucket({ ratePerSec: 40, burst: 80, now });
    for (let i = 0; i < 1000; i++) {
        now.advance(25); // 40 messages/s
        assert.equal(bucket.take(), true);
    }
});
