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

// Object to store WebSocket connections by session ID
const sessions = {};

// Handle HTTP upgrade requests to upgrade them to WebSocket connections
server.on('upgrade', (request, socket, head) => {
    let sessionId = null;
    // Handle the WebSocket connection upgrade
    wss.handleUpgrade(request, socket, head, (ws) => {

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
                    sessions[sessionId].forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(messageJson));
                        }
                    });
                }
            }




            // Broadcast the message to all other clients in the same session
            // sessions[sessionId].forEach(client => {
            //     if (client !== ws && client.readyState === WebSocket.OPEN) {
            //         console.log(typeof message);
            //         client.send(message.toString());
            //     }
            // });
        });

        // Set up an event listener for when the WebSocket connection is closed
        ws.on('close', () => {
            // Remove the closed connection from the session
            sessions[sessionId] = sessions[sessionId].filter(client => client !== ws); //this "filter" sometimes causes an error
            // If the session is empty, delete it
            if (sessions[sessionId].length === 0) {
                delete sessions[sessionId];
            }
        });

        function giveSessionId(ws) {
            const sessionId = uuidv4();
            console.log(`Gave connection session ID ${sessionId}.`);
            if (!sessions[sessionId]) {
                sessions[sessionId] = [];
            }
            sessions[sessionId].push(ws);
            sessionIdString = JSON.stringify({ sessionId: sessionId });
            ws.send(sessionIdString);
        }

        function mergeSessions(ws, messageJson) {
            if (sessions[messageJson.sessionId]) {
                sessionId = messageJson.sessionId;
                sessions[sessionId].push(ws);
                const numberOfSessionMembers = sessions[sessionId].length;
                const responseJson = { response: "sessionConnected", numberOfSessionMembers: numberOfSessionMembers, deviceInfo: messageJson.deviceInfo };
                sessions[sessionId].forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(responseJson));
                    }
                });
            }
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

