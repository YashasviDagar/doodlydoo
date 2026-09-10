# Single-service build: client is built to static assets and served by the same Express/WS
# process (see server/src/index.ts) - one Railway service instead of hosting them separately.

FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ .
RUN npm run build

FROM node:22-alpine AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=server-build /app/server/dist ./dist
COPY --from=server-build /app/server/src/db/migrations ./src/db/migrations
COPY --from=client-build /app/client/dist ./client-dist
EXPOSE 4000
CMD ["node", "dist/index.js"]
