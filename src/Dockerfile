FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder

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
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

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
