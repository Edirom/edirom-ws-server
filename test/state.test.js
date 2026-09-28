const test = require('node:test');
const assert = require('node:assert/strict');
const {
    STATE_SCHEMA,
    createDefaultState,
    sanitizeStatePatch,
    getSharedState,
    adoptSessionState,
    applyStateUpdate
} = require('../src/state');

test('createDefaultState returns the schema defaults', () => {
    assert.deepEqual(createDefaultState(), { edition: null, work: null, connection: null });
});

test('sanitizeStatePatch drops unknown keys', () => {
    assert.deepEqual(sanitizeStatePatch({ edition: 'ed-1', bogus: 'x' }), { edition: 'ed-1' });
});

test('sanitizeStatePatch drops invalid values', () => {
    assert.deepEqual(sanitizeStatePatch({ edition: 'x'.repeat(300) }), {});
    assert.deepEqual(sanitizeStatePatch({ edition: 42 }), {});
});

test('sanitizeStatePatch tolerates malformed input', () => {
    assert.deepEqual(sanitizeStatePatch(null), {});
    assert.deepEqual(sanitizeStatePatch(undefined), {});
    assert.deepEqual(sanitizeStatePatch([]), {});
    assert.deepEqual(sanitizeStatePatch('nope'), {});
});

test('getSharedState only returns keys marked shared in STATE_SCHEMA', () => {
    const state = { edition: 'ed-1', work: 'w-1', connection: null };
    assert.deepEqual(getSharedState(state), state);
    assert.deepEqual(
        Object.keys(getSharedState(state)).sort(),
        Object.keys(STATE_SCHEMA).filter(k => STATE_SCHEMA[k].shared).sort()
    );
});

test('adoptSessionState returns {} when no other clients exist', () => {
    const joiner = { state: createDefaultState() };
    assert.deepEqual(adoptSessionState(joiner, []), {});
});

test('adoptSessionState returns {} when nobody has reported state yet', () => {
    const joiner = { state: createDefaultState() };
    const existing = [{ state: createDefaultState(), stateUpdatedAt: 0 }];
    assert.deepEqual(adoptSessionState(joiner, existing), {});
});

test("adoptSessionState adopts the most recently updated member's shared state", () => {
    const joiner = { state: createDefaultState() };
    const older = { state: { edition: 'old', work: null, connection: null }, stateUpdatedAt: 10 };
    const newer = { state: { edition: 'new', work: 'w1', connection: null }, stateUpdatedAt: 20 };
    const patch = adoptSessionState(joiner, [older, newer]);
    assert.deepEqual(patch, { edition: 'new', work: 'w1', connection: null });
    assert.deepEqual(joiner.state, { edition: 'new', work: 'w1', connection: null });
});

test('applyStateUpdate ignores a patch that changes nothing', () => {
    const sender = { id: 's1', state: createDefaultState(), stateUpdatedAt: 0 };
    const session = { clients: [sender] };
    const ops = applyStateUpdate(sender, session, { patch: { edition: null } });
    assert.deepEqual(ops, []);
    assert.equal(sender.stateUpdatedAt, 0);
});

test('applyStateUpdate updates the sender and returns ops for other clients', () => {
    const sender = { id: 's1', state: createDefaultState(), stateUpdatedAt: 0 };
    const other = { id: 's2', state: createDefaultState(), stateUpdatedAt: 0 };
    const session = { clients: [sender, other] };
    const ops = applyStateUpdate(sender, session, { patch: { edition: 'ed-1' }, cause: 'user' });
    assert.equal(sender.state.edition, 'ed-1');
    assert.notEqual(sender.stateUpdatedAt, 0);
    assert.deepEqual(ops, [{ client: other, patch: { edition: 'ed-1' } }]);
    assert.equal(other.state.edition, 'ed-1');
});

test('applyStateUpdate does not fan out a syncResult correction', () => {
    const sender = { id: 's1', state: createDefaultState(), stateUpdatedAt: 0 };
    const other = { id: 's2', state: createDefaultState(), stateUpdatedAt: 0 };
    const session = { clients: [sender, other] };
    const ops = applyStateUpdate(sender, session, { patch: { edition: 'ed-1' }, cause: 'syncResult' });
    assert.deepEqual(ops, []);
    assert.equal(sender.state.edition, 'ed-1');
    assert.equal(other.state.edition, null);
});

test('applyStateUpdate skips other clients that already have the value', () => {
    const sender = { id: 's1', state: createDefaultState(), stateUpdatedAt: 0 };
    const other = { id: 's2', state: { edition: 'ed-1', work: null, connection: null }, stateUpdatedAt: 0 };
    const session = { clients: [sender, other] };
    const ops = applyStateUpdate(sender, session, { patch: { edition: 'ed-1' } });
    assert.deepEqual(ops, []);
});
