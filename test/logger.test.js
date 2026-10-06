const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, alignRows, parseLevel } = require('../src/logger');

function capture(options) {
    const out = [];
    const err = [];
    const clock = { ms: Date.UTC(2026, 9, 6, 12, 0, 0) };
    const log = createLogger({
        out: { write: (l) => out.push(l) },
        err: { write: (l) => err.push(l) },
        now: () => new Date(clock.ms),
        ...options
    });
    return { log, out, err, clock };
}

test('pretty format prints only the message, detail lines and error; fields stay out', () => {
    const { log, out } = capture();
    log.info('Hello', { secret: 'x' }, { detail: ['line one', 'line two'] });
    const lines = out[0].trimEnd().split('\n');
    assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}INFO {3}Hello$/);
    assert.match(lines[1], /^ +line one$/);
    assert.equal(lines.length, 3);
    assert.ok(!out[0].includes('secret'));
});

test('json format emits one parseable record with fields, and drops detail', () => {
    const { log, out } = capture({ format: 'json' });
    log.info('Hello', { sessionId: 'ABC' }, { detail: ['human only'] });
    const record = JSON.parse(out[0]);
    assert.deepEqual(record, { time: '2026-10-06T12:00:00.000Z', level: 'info', msg: 'Hello', sessionId: 'ABC' });
});

test('json format serializes errors, including stack', () => {
    const { log, err } = capture({ format: 'json' });
    log.error('boom', { err: new TypeError('bad') });
    const record = JSON.parse(err[0]);
    assert.equal(record.err.name, 'TypeError');
    assert.equal(record.err.message, 'bad');
    assert.match(record.err.stack, /TypeError: bad/);
});

test('warn and error go to stderr, info and debug to stdout', () => {
    const { log, out, err } = capture({ level: 'debug' });
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    assert.equal(out.length, 2);
    assert.equal(err.length, 2);
});

test('level filters lower-severity entries; silent drops everything', () => {
    const warnOnly = capture({ level: 'warn' });
    warnOnly.log.info('no'); warnOnly.log.warn('yes');
    assert.equal(warnOnly.out.length + warnOnly.err.length, 1);

    const silent = capture({ level: 'silent' });
    silent.log.error('no');
    assert.equal(silent.out.length + silent.err.length, 0);
});

test('an unknown level falls back to info', () => {
    assert.equal(parseLevel('verbose'), 'info');
    assert.equal(parseLevel(undefined), 'info');
    assert.equal(parseLevel(' WARN '), 'warn');
});

test('pretty prints stack frames for errors but only the message for warnings', () => {
    const { log, out, err } = capture();
    log.error('boom', { err: new Error('bad') });
    log.warn('hmm', { err: new Error('meh') });
    assert.match(err[0], /Error: bad\n.*at /);
    assert.match(err[1], /Error: meh/);
    assert.ok(!/\n.*at /.test(err[1]));
    assert.equal(out.length, 0);
});

test('throttled entries are emitted once per interval and report how many were suppressed', () => {
    const { log, err, clock } = capture({ throttleMs: 1000 });
    log.warn('limit hit', {}, { throttle: 'k' });
    log.warn('limit hit', {}, { throttle: 'k' });
    log.warn('limit hit', {}, { throttle: 'k' });
    log.warn('other', {}, { throttle: 'other-key' });
    assert.equal(err.length, 2);
    clock.ms += 1500;
    log.warn('limit hit', {}, { throttle: 'k' });
    assert.equal(err.length, 3);
    assert.match(err[2], /\(\+2 similar suppressed\)/);
});

test('banner is boxed to the title width, and skipped for json', () => {
    const pretty = capture();
    pretty.log.banner('TITLE');
    const [top, middle, bottom] = pretty.out[0].trimEnd().split('\n');
    assert.equal(middle, '### TITLE ###');
    assert.equal(top, '#'.repeat(middle.length));
    assert.equal(bottom, top);

    const json = capture({ format: 'json' });
    json.log.banner('TITLE');
    assert.equal(json.out.length, 0);
});

test('colour codes appear only when colour is enabled', () => {
    const plain = capture({ color: false });
    plain.log.info('x');
    const colored = capture({ color: true });
    colored.log.info('x');
    assert.ok(!plain.out[0].includes('\x1b['));
    assert.ok(colored.out[0].includes('\x1b['));
});

test('alignRows pads keys to the widest one', () => {
    assert.deepEqual(alignRows({ A: '1', Long: '2' }), ['A     1', 'Long  2']);
});
