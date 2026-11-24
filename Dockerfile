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
ENV NODE_ENV=production \
    GV_DATA_DIR=/data \
    GV_PORT=8686 \
    GV_VERSION=${GV_VERSION}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY --from=web /app/web/dist ./web/dist

EXPOSE 8686
VOLUME /data
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GV_PORT||8686)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
