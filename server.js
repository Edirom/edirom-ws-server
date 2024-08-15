// Import the WebSocket library
const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require("uuid");
const fs = require('fs');

const qr_codes = JSON.parse(fs.readFileSync('data/qr_codes.json', 'utf8'));

// Create an Express application
const app = express();
const port = 3000;

// Create an HTTP server using the Express app
const server = require('http').createServer(app);

// Create a WebSocket server, but do not start it yet
const wss = new WebSocket.Server({ noServer: true });

console.log("I run!");

// Object to store WebSocket connections by session ID
const sessions = {};

// Handle HTTP upgrade requests to upgrade them to WebSocket connections
server.on('upgrade', (request, socket, head) => {
    console.log("New connection!");
    let sessionId = null;
    // Handle the WebSocket connection upgrade
    wss.handleUpgrade(request, socket, head, (ws) => {

        handleNewSession(ws);

        // Set up an event listener for messages received on this WebSocket connection
        // TODO: I gave to the parsing of data way more robust. The server must not crash even when the data sent by the client is not as expected!!
        ws.on('message', (message) => {
            console.log(`Received message: ${message}`);
            const messageJson = JSON.parse(message);
            if (messageJson.request) {
                if (messageJson.request === "giveSessionId") {
                    giveSessionId(ws);
                }
                else if (messageJson.request === "mergeSessions") {
                    mergeSessions(ws, messageJson);
                }
            }
            else {
                if (messageJson.message) {
                    // Broadcast the message to all other clients in the same session
                    sessions[sessionId].clients.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(messageJson));
                        }
                    });
                }
            }
        });

        // Set up an event listener for when the WebSocket connection is closed
        ws.on('close', () => {
            console.log("Connection closed!");
            handleClientDisconnect(ws);
        });

        // TODO: Do I have to definde this functions inside the upgrade handler or outside of it?
        function handleNewSession(ws) {
            sessionId = uuidv4();
            console.log(`Gave connection session ID ${sessionId}.`);
            sessions[sessionId] = { clients: [ws] };
            console.log("Number of sessions: ", Object.keys(sessions).length);
            console.log("Clients in this session: ", sessions[sessionId].clients.length);
        }

        function giveSessionId(ws) {
            sessionIdString = JSON.stringify({ sessionId: sessionId });
            console.log(`Sending session ID ${sessionIdString}.`);
            ws.send(sessionIdString);
        }

        function mergeSessions(ws, messageJson) {
            // TODO: Respond to client if the session ID is not valid
            // TODO: Delete old entry of session
            if (sessions[messageJson.sessionId]) {
                sessionId = messageJson.sessionId;
                sessions[sessionId].clients.push(ws);
                removeClient(ws);
                console.log("Number of sessions: ", Object.keys(sessions).length);
                console.log("Clients in this session: ", sessions[sessionId].clients.length);
                const numberOfSessionMembers = sessions[sessionId].clients.length;
                const responseJson = { response: "sessionConnected", numberOfSessionMembers: numberOfSessionMembers, deviceInfo: messageJson.deviceInfo };
                sessions[sessionId].clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) { //TODO: Should I use this WebSocket.OPEN check every time I send something?
                        client.send(JSON.stringify(responseJson));
                    }
                });
            }
        }

        function handleClientDisconnect(ws) {
            removeClient(ws);
            // TO DO: Notify the remaining clients that a client has left

        }

        function removeClient(ws) {
            // Remove the closed client from the session
            sessions[sessionId].clients = sessions[sessionId].clients.filter(client => client !== ws);
            console.log("Clients in this session: ", sessions[sessionId].clients.length);
            if (sessions[sessionId].clients.length === 0) {
                delete sessions[sessionId];
            }
            console.log("Number of sessions: ", Object.keys(sessions).length);
        }
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

