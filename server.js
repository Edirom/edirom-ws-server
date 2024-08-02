// Import the WebSocket library
const WebSocket = require('ws');

// Create a new WebSocket server listening on port 8080
const wss = new WebSocket.Server({ port: 8080 });

// When a new client connects
wss.on('connection', (ws) => {
    console.log('New client connected');

    // When the server receives a message from a client
    ws.on('message', (message) => {
        console.log(`Received: ${message}`);
        // Echo the message back to the client
        ws.send(`You said: ${message}`);
    });

    // When the client disconnects
    ws.on('close', () => {
        console.log('Client disconnected');
    });

    // Send a welcome message to the client when they connect
    ws.send('Welcome to the WebSocket server!');
});

console.log('WebSocket server is listening on ws://localhost:8080');
