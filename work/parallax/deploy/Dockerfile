# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=61281 PARALLAX_STATE_DIR=/var/lib/ropad ROPAD_BIND_HOST=0.0.0.0
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json camera-catalog.json ./
COPY --chown=node:node *.cjs *.luau ./
COPY --chown=node:node dist ./dist
COPY --chown=node:node deploy/healthcheck.cjs deploy/check-readiness.cjs ./deploy/
RUN mkdir -p /var/lib/ropad && chown node:node /var/lib/ropad
USER node
EXPOSE 61281
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "deploy/healthcheck.cjs"]
CMD ["node", "server.cjs"]
