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
    let client = {
        id: null,
        ws: null,
        metadata: { deviceType: "unknown", os: "unknown", browser: "unknown" }
    };
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
                else if (messageJson.request === "giveClientId") {
                    sendClientId(ws);
                }
                else if (messageJson.request === "giveSessionData") {
                    sendSessionData(ws);
                }
                else if (messageJson.request === "mergeSessions") {
                    mergeSessions(ws, messageJson);
                }
            }
            else {
                if (messageJson.message) {
                    if (messageJson.message === "userAgent") {
                        client["metadata"] = parseUserAgent(messageJson.userAgent);
                    }
                    if (messageJson.message === "scanned-qr-code") {
                        const resolved_qr_code_data = qr_codes[messageJson.code];
                        console.log("Resolved QR code data:");
                        console.log(resolved_qr_code_data);

                        const responseJson = { message: "open-links", links: resolved_qr_code_data };
                        sessions[sessionId].clients.forEach(client => {
                            if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
                                client.ws.send(JSON.stringify(responseJson));
                            }
                        });
                    }
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
            client["id"] = uuidv4();
            client["ws"] = ws;
            sessionId = uuidv4();
            console.log(`Gave connection client ID ${client["id"]} and session ID ${sessionId}.`);
            sessions[sessionId] = { clients: [client] };
            console.log("Number of sessions: ", Object.keys(sessions).length);
            console.log("Clients in this session: ", sessions[sessionId].clients.length);
        }

        function sendSessionId(ws) {
            sessionIdString = JSON.stringify({ sessionId: sessionId });
            console.log(`Sending session ID ${sessionIdString}.`);
            ws.send(sessionIdString);
        }

        function sendClientId(ws) {
            clientIdString = JSON.stringify({ clientId: client.id });
            console.log(`Sending client ID ${clientIdString}.`);
            ws.send(clientIdString);
        }

        function sendSessionData(ws) {
            const sessionData = getSessionDataForClients();
            const sessionDataString = JSON.stringify({ sessionData: sessionData });
            console.log(`Sending session data ${sessionDataString}.`);
            ws.send(sessionDataString);
        }

        function mergeSessions(ws, messageJson) {
            // TODO: Respond to client if the session ID is not valid
            // TODO: Delete old entry of session
            // TODO: Clean this up by splitting in functions
            if (sessions[messageJson.sessionId]) {
                const oldSessionId = sessionId;
                sessionId = messageJson.sessionId;
                sessions[sessionId].clients.push(client);
                removeClient(ws, oldSessionId);
                console.log("Number of sessions: ", Object.keys(sessions).length);
                console.log("Clients in this session: ", sessions[sessionId].clients.length);
                // Answer the client that the session was successfully merged
                let responseJson = { response: "sessionMerged", sessionId: sessionId };
                ws.send(JSON.stringify(responseJson));
                // Notify the other clients in the session that a new client has connected
                const filteredClientData = { id: client.id, metadata: client.metadata };
                const filteredSessionMembers = sessions[sessionId].clients.map(client => { return { id: client.id, metadata: client.metadata } });
                const sessionData = getSessionDataForClients();
                responseJson = { response: "clientConnected", clientData: filteredClientData, sessionData: sessionData };
                sessions[sessionId].clients.forEach(client => {
                    if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) { //TODO: Should I use this WebSocket.OPEN check every time I send something?
                        client.ws.send(JSON.stringify(responseJson));
                    }
                });
            }
        }

        function getSessionDataForClients() {
            const filteredSessionMembers = sessions[sessionId].clients.map(client => { return { id: client.id, metadata: client.metadata } });
            return { sessionId: sessionId, sessionMembers: filteredSessionMembers };
        }

        function handleClientDisconnect(ws) { //TODO: I could probaly merge this with the mergeSessions function and just make it a handleClientConnectionUpdate or something. The same thing in the edirom.
            removeClient(ws, sessionId);
            // Notify the other clients in the session that a client has disconnected
            const filteredClientData = { id: client.id, metadata: client.metadata };
            if (sessions[sessionId]) {
                const filteredSessionMembers = sessions[sessionId].clients.map(client => { return { id: client.id, metadata: client.metadata } });
                const sessionData = getSessionDataForClients();
                responseJson = { response: "clientDisconnected", clientData: filteredClientData, sessionData: sessionData };
                sessions[sessionId].clients.forEach(client => {
                    if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) { //TODO: Should I use this WebSocket.OPEN check every time I send something?
                        client.ws.send(JSON.stringify(responseJson));
                    }
                });
            }
        }

        function removeClient(client, sessionId) {
            // Remove the closed client from the session
            sessions[sessionId].clients = sessions[sessionId].clients.filter(client => client.ws !== ws);
            console.log("Clients in this session: ", sessions[sessionId].clients.length);
            if (sessions[sessionId].clients.length === 0) {
                delete sessions[sessionId];
            }
            console.log("Number of sessions: ", Object.keys(sessions).length);
        }

        function parseUserAgent(userAgentString) {
            let os = "unknown";
            let deviceType = "unknown";
            let browser = "unknown";

            // OS
            if (userAgentString.includes("Windows")) {
                os = "Windows";
            }
            else if (userAgentString.includes("Android")) {
                os = "Android";
            }
            else if (userAgentString.includes("Linux")) {
                os = "Linux";
            }
            else if (userAgentString.includes("iPhone") || userAgentString.includes("iPad")) {
                os = "iOS";
            }
            else if (userAgentString.includes("Mac")) {
                os = "MacOS";
            }

            // Device type
            if (os === "Windows" || os === "Linux" || os === "MacOS") {
                deviceType = "Desktop";
            }
            else if (os === "Android" || os === "iOS") {
                deviceType = "Mobilgerät";
            }

            // Browser
            if (userAgentString.includes("Firefox")) {
                browser = "Firefox";
            }
            else if (userAgentString.includes("Chrome")) {
                browser = "Chrome";
            }
            else if (userAgentString.includes("Safari")) {
                browser = "Safari";
            }
            else if (userAgentString.includes("Edge")) {
                browser = "Edge";
            }

            return { deviceType: deviceType, os: os, browser: browser };
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

