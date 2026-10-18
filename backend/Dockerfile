# Build stage — installs production dependencies only.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime stage — no npm, no compilers, runs as the unprivileged `node` user.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

USER node
EXPOSE 5002

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:5002/health || exit 1

CMD ["node", "server.js"]
