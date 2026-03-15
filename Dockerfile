FROM node:24-alpine AS base
RUN npm install -g pnpm

# ─── Install all workspace dependencies ───────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/mcp/package.json  ./packages/mcp/
COPY apps/api/package.json      ./apps/api/
RUN pnpm install --frozen-lockfile

# ─── Build all packages ────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm --filter @aegis-protocol/core build
RUN pnpm --filter @aegis-protocol/api build

# ─── Standalone deployment bundle (resolves workspace symlinks) ───────────────
FROM build AS bundle
WORKDIR /app
# pnpm deploy creates a self-contained folder with all deps resolved — no symlinks
RUN pnpm --filter @aegis-protocol/api deploy /deploy --prod

# Copy compiled output (deploy only gets node_modules, not dist)
COPY --from=build /app/packages/core/dist /deploy/node_modules/@aegis-protocol/core/dist
COPY --from=build /app/apps/api/dist      /deploy/dist
# Agent-readable skill manifest — served at GET /skill.md
COPY --from=build /app/skill.md           /deploy/skill.md
# DevSpot agent manifest + execution log
COPY --from=build /app/agent.json         /deploy/agent.json
COPY --from=build /app/agent_log.json     /deploy/agent_log.json
# Chain config (EAS schema UID, network)
COPY --from=build /app/config             /deploy/config

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

RUN addgroup -S aegis && adduser -S aegis -G aegis

COPY --from=bundle --chown=aegis:aegis /deploy ./

USER aegis

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
