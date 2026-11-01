# syntax=docker/dockerfile:1

# ---- build the browser bundle -------------------------------------------------
FROM oven/bun:1.4.4-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
RUN bun run build

# ---- runtime ------------------------------------------------------------------
# The server is plain Bun + TypeScript with no runtime npm dependencies, so the
# final image only needs the server sources and the built client.
FROM oven/bun:1.4.4-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

COPY package.json ./
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY --from=build /app/dist ./dist

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "src/server/index.ts"]
