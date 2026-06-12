FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

# Install deps first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server.js ./
COPY public ./public

USER node

EXPOSE 3000

CMD ["node", "server.js"]
