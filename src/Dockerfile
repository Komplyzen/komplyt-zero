FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY *.ts ./
COPY tools ./tools
COPY bin ./bin
COPY public ./public
COPY ee ./ee

# Build server (CLI not needed in container)
RUN bun build ./index.ts --outdir=dist --target=bun

# Production image
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288

WORKDIR /app

# Copy built output and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./dist/

COPY --from=builder /app/public ./dist/public

# Licence texts for what the image contains: the core is Apache-2.0, ee/ has its own terms.
COPY licenses /licenses
COPY --from=builder /app/ee/LICENSE /licenses/ee-LICENSE
LABEL org.opencontainers.image.licenses="Apache-2.0 AND (PolyForm-Noncommercial-1.0.0 OR LicenseRef-Komplyzen-Commercial)"

ENV NODE_ENV=production
EXPOSE 3000

# Unprivileged user shipped with the bun image (uid 1000). The app code stays root-owned and read-only to it.
USER bun

CMD ["bun", "run", "dist/index.js"]
