FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=3000
ENV DATA_FILE=/data/timecard.json

EXPOSE 3000

CMD ["node", "server.js"]
