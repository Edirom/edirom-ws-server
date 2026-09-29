const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeLabel } = require('../src/client');

test('sanitizeLabel passes an ordinary name through unchanged', () => {
    assert.equal(sanitizeLabel('Alice’s iPad', 64), 'Alice’s iPad');
});

test('sanitizeLabel strips control characters, including newlines and NUL', () => {
    assert.equal(sanitizeLabel('Al\nice\r\u0000\u001b[31m', 64), 'Alice[31m');
});

test('sanitizeLabel strips line/paragraph separators and bidi overrides', () => {
    assert.equal(sanitizeLabel('a b c‮d⁦e', 64), 'abcde');
});

test('sanitizeLabel keeps emoji sequences that use a zero-width joiner', () => {
    const family = '👨‍👩‍👧';
    assert.equal(sanitizeLabel(family, 64), family);
});

test('sanitizeLabel trims surrounding whitespace', () => {
    assert.equal(sanitizeLabel('  Bob  ', 64), 'Bob');
});

test('sanitizeLabel truncates to the max length', () => {
    assert.equal(sanitizeLabel('A'.repeat(200), 64), 'A'.repeat(64));
});

test('sanitizeLabel truncates by code point and never splits a surrogate pair', () => {
    const result = sanitizeLabel('😀'.repeat(100), 64);
    assert.equal(Array.from(result).length, 64);
    assert.equal(result, '😀'.repeat(64));
});

test('sanitizeLabel falls back for non-strings and for empty results', () => {
    assert.equal(sanitizeLabel(undefined, 64), 'unknown');
    assert.equal(sanitizeLabel(null, 64), 'unknown');
    assert.equal(sanitizeLabel({ evil: 'object' }, 64), 'unknown');
    assert.equal(sanitizeLabel('', 64), 'unknown');
    assert.equal(sanitizeLabel('\n\t \u0000', 64), 'unknown');
    assert.equal(sanitizeLabel('   ', 64, 'n/a'), 'n/a');
});
