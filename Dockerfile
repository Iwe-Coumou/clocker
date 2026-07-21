FROM node:20-alpine

# su-exec drops root to the `node` user in the entrypoint without spawning an
# init process the way `su` would.
RUN apk add --no-cache su-exec

WORKDIR /app

# npm ci installs exactly what the lockfile pins, so an image built today and
# one built next year contain the same dependency tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R node:node /app

ENV PORT=3000
ENV DATA_FILE=/data/clocker.json

EXPOSE 3000

# Starts as root, chowns the data volume, then execs the app as `node`.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
