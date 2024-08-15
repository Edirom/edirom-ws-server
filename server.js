// Import the WebSocket library
const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require("uuid");

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
    let clientId = null;
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
                    sendSessionId(ws);
                }
                else if (messageJson.request === "mergeSessions") {
                    mergeSessions(ws, messageJson);
                }
            }
            else {
                if (messageJson.message) {
                    // Broadcast the message to all other clients in the same session
                    sessions[sessionId].clients.forEach(client => {
                        if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
                            client.ws.send(JSON.stringify(messageJson));
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
            clientId = uuidv4();
            sessionId = uuidv4();
            console.log(`Gave connection client ID ${clientId} and session ID ${sessionId}.`);
            sessions[sessionId] = { clients: [{ clientId: clientId, ws: ws }] };
            console.log("Number of sessions: ", Object.keys(sessions).length);
            console.log("Clients in this session: ", sessions[sessionId].clients.length);
        }

        function sendSessionId(ws) {
            sessionIdString = JSON.stringify({ sessionId: sessionId });
            console.log(`Sending session ID ${sessionIdString}.`);
            ws.send(sessionIdString);
        }

        function mergeSessions(ws, messageJson) {
            // TODO: Respond to client if the session ID is not valid
            // TODO: Delete old entry of session
            // TODO: Clean this up by splitting in functions
            if (sessions[messageJson.sessionId]) {
                const oldSessionId = sessionId;
                sessionId = messageJson.sessionId;
                sessions[sessionId].clients.push({ clientId: clientId, ws: ws });
                removeClient(ws, oldSessionId);
                console.log("Number of sessions: ", Object.keys(sessions).length);
                console.log("Clients in this session: ", sessions[sessionId].clients.length);
                // Answer the client that the session was successfully merged
                let responseJson = { response: "sessionMerged", sessionId: sessionId };
                ws.send(JSON.stringify(responseJson));
                // Notify the other clients in the session that a new client has connected
                const numberOfSessionMembers = sessions[sessionId].clients.length;
                responseJson = { response: "clientConnected", numberOfSessionMembers: numberOfSessionMembers, deviceInfo: messageJson.deviceInfo };
                sessions[sessionId].clients.forEach(client => {
                    if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) { //TODO: Should I use this WebSocket.OPEN check every time I send something?
                        client.ws.send(JSON.stringify(responseJson));
                    }
                });
            }
        }

        function handleClientDisconnect(ws) {
            // TO DO: Notify the remaining clients that a client has left. How does the Edirom know which client disconnected? I should programm a more detailed client object in the sessions array with unique ID and metadata like the OS, browser etc. The edirom can then get this information and can be sure that the data is up to date and has the metadata.
            const responseJson = { response: "clientDisconnected", numberOfSessionMembers: sessions[sessionId].clients.length };
            sessions[sessionId].clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(responseJson));
                }
            });

            removeClient(ws, sessionId);

        }

        function removeClient(ws, sessionId) {
            // Remove the closed client from the session
            sessions[sessionId].clients = sessions[sessionId].clients.filter(client => client.ws !== ws);
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

