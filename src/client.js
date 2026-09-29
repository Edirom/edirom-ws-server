const { v4: uuidv4 } = require('uuid');
const { createDefaultState } = require('./state');

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

module.exports = { createClient };
