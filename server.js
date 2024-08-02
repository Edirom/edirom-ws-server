// Import the WebSocket library
const express = require('express');
const WebSocket = require('ws');

// Create an Express application
const app = express();
const port = 3000;

// Create an HTTP server using the Express app
const server = require('http').createServer(app);

// Create a WebSocket server, but do not start it yet
const wss = new WebSocket.Server({ noServer: true });

// Object to store WebSocket connections by session ID
const sessions = {};

// Handle HTTP upgrade requests to upgrade them to WebSocket connections
// Handle HTTP upgrade requests to upgrade them to WebSocket connections
server.on('upgrade', (request, socket, head) => {
    // Parse the URL to get the session ID
    const url = new URL(request.url, `http://${request.headers.host}`);
    const sessionId = url.pathname.split('/').pop();

    // Handle the WebSocket connection upgrade
    wss.handleUpgrade(request, socket, head, (ws) => {
        // If the session does not exist, create an empty array for it
        if (!sessions[sessionId]) {
            sessions[sessionId] = [];
        }
        // Add the new WebSocket connection to the session
        sessions[sessionId].push(ws);

        // Set up an event listener for messages received on this WebSocket connection
        ws.on('message', (message) => {
            console.log(`Received message: ${message} in session: ${sessionId}`);
            // Broadcast the message to all other clients in the same session
            sessions[sessionId].forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    console.log(typeof message);
                    client.send(message.toString());
                }
            });
        });

        // Set up an event listener for when the WebSocket connection is closed
        ws.on('close', () => {
            // Remove the closed connection from the session
            sessions[sessionId] = sessions[sessionId].filter(client => client !== ws);
            // If the session is empty, delete it
            if (sessions[sessionId].length === 0) {
                delete sessions[sessionId];
            }
        });

        // Send a welcome message to the new connection
        ws.send(`Connected to session ${sessionId}`);
    });
});


// Define a simple HTTP GET route for the root URL
app.get('/', (req, res) => {
    // Send a plain text response
    res.send('WebSocket server is running');
});

// Start the HTTP server and listen on the specified port
server.listen(port, () => {
    console.log(`Server is listening on http://localhost:${port}`);
});

// // Create a new WebSocket server listening on port 8080
// const wss = new WebSocket.Server({ port: 8080 });

// // When a new client connects
// wss.on('connection', (ws) => {
//     console.log('New client connected');

//     // When the server receives a message from a client
//     ws.on('message', (message) => {
//         console.log(`Received: ${message}`);
//         // Echo the message back to the client
//         ws.send(`You said: ${message}`);
//     });

//     // When the client disconnects
//     ws.on('close', () => {
//         console.log('Client disconnected');
//     });

//     // Send a welcome message to the client when they connect
//     ws.send('Welcome to the WebSocket server!');
// });
