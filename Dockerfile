# ---- PS5 Dump Forge (GPL-3.0, https://github.com/quer3q/ps5-dump-forge) -------------
# The official Linux release's command-line tool, for the image's architecture.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS forge
ARG TARGETARCH
ARG FORGE_VERSION=0.5.7
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && case "$TARGETARCH" in \
      amd64) arch=x86-64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "PS5 Dump Forge has no Linux build for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/forge.tgz \
      "https://github.com/quer3q/ps5-dump-forge/releases/download/v${FORGE_VERSION}/ps5-dump-forge-${FORGE_VERSION}-linux-${arch}.tar.gz" \
 && mkdir /tmp/forge && tar -xzf /tmp/forge.tgz -C /tmp/forge \
 && install -m 755 "$(find /tmp/forge -type f -name ps5-dump-forge | head -n1)" /usr/local/bin/ps5-dump-forge

# ---- Web UI ----------------------------------------------------------------
FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- Server ----------------------------------------------------------------
FROM node:24-slim
ARG GV_VERSION=dev
ARG FORGE_VERSION=0.5.7
ENV NODE_ENV=production \
    GV_DATA_DIR=/data \
    GV_PORT=8686 \
    GV_VERSION=${GV_VERSION} \
    FORGE_VERSION=${FORGE_VERSION}
WORKDIR /app
COPY --from=forge /usr/local/bin/ps5-dump-forge /usr/local/bin/ps5-dump-forge
# Fail the build if the converter can't run on this architecture.
RUN (ps5-dump-forge 2>&1 || true) | grep -q "usage: ps5-dump-forge"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY --from=web /app/web/dist ./web/dist

EXPOSE 8686
VOLUME /data
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GV_PORT||8686)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
