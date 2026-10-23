FROM node:25-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM node:25-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:25-bookworm-slim AS runtime
ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=3000
WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/sgerner/flavorithm" \
	org.opencontainers.image.description="Flavorithm — Where flavor meets algorithms"

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/build ./build
COPY --chown=node:node server.mjs ./server.mjs
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
