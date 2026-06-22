# ── Stage 1: run tests ────────────────────────────────────────────────────────
FROM node:20-alpine AS test
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci
COPY server/ ./server/
RUN npm run test -w server && touch /app/test.ok

# ── Stage 2: build client ─────────────────────────────────────────────────────
FROM node:20-alpine AS build-client
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci
COPY client/ ./client/
RUN npm run build -w client

# ── Stage 3: build server ─────────────────────────────────────────────────────
FROM node:20-alpine AS build-server
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci
COPY server/ ./server/
RUN npm run build -w server

# ── Stage 4: production image ─────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci --omit=dev
COPY --from=test /app/test.ok /app/test.ok
COPY --from=build-server /app/server/dist ./server/dist
COPY --from=build-client /app/client/dist ./client/dist
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
