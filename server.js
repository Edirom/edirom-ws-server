const { createServer } = require('./src/app');

console.log("I run!");

const port = process.env.PORT || 3000;
const { server } = createServer();

server.listen(port, () => {
    console.log(`Server is listening on http://localhost:${port}`);
});
