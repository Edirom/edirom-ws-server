FROM node:20-alpine

WORKDIR /usr/src/app

COPY . .

RUN npm install

# Session-termination logs (and their rotated siblings) live here — mount a
# host directory here to keep them across container restarts/redeploys.
VOLUME ["/usr/src/app/data"]

CMD ["node", "server.js"]
