const { createServer } = require('./src/app');

console.log("I run!");

(async () => {
    const port = process.env.PORT || 3000;
    const { server } = await createServer();

    server.listen(port, () => {
        console.log(`Server is listening on http://localhost:${port}`);
    });
})();
