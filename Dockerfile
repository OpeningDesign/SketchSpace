# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# build-essential + python3 so better-sqlite3 can compile if no prebuild matches
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json* ./
COPY server ./server
COPY client ./client
# The editor is vendored, not an npm dependency - run `npm run sync:editor`
# on the host before building this image.
COPY vendor ./vendor
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y

COPY --from=build /app/dist ./dist

ENV PORT=3000
ENV SKETCHSPACE_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "dist/server/index.js"]
