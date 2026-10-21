# syntax=docker/dockerfile:1
#
# Q38 in a container: the built UI and the API server (server/prod.mjs) on
# port 4173. llama-server, the OCR server, embeddings and SearXNG stay where
# they are; the container reaches them over the network.
#
#   docker compose up -d --build        (see compose.yaml)
#
# Multi-arch: node's Debian images and @napi-rs/canvas both ship amd64 and
# arm64, so the same file builds on an x86 desktop and on a DGX Spark.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---------------------------------------------------- runtime node_modules
# Only what the server loads: pdfjs-dist, and @napi-rs/canvas (its optional
# dependency) for OCR page rendering — installed for the target platform.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE}

# gh: the GitHub tools run it (read-only `gh api --method GET`). Set
# --build-arg WITH_GH=0 to leave it out; the GitHub tools then report it missing.
# git: `npm run skills:sync` does a sparse clone to fill the skills folder.
ARG WITH_GH=1
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git; \
    if [ "$WITH_GH" = "1" ]; then \
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg; \
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends gh; \
    fi; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    Q38_STATE_DIR=/data \
    WORKSPACE_DIR=/workspace \
    Q38_SKILLS_DIR=/skills \
    LLAMA_SERVER_URL=http://127.0.0.1:8080

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY scripts ./scripts
# the sample workspace, used only when nothing is mounted at /workspace
COPY workspace /workspace

RUN mkdir -p /data /skills /home/node/.config/gh \
 && chown -R node:node /data /skills /workspace /home/node

USER node
EXPOSE 4173
VOLUME ["/data", "/skills"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/prod.mjs"]
