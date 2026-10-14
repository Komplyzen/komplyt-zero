FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS builder

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
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

WORKDIR /app

# Copy built output and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./dist/

COPY --from=builder /app/public ./dist/public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]
