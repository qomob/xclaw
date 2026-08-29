FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl curl postgresql-client && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# npm ci + lockfile：可复现构建（勿改回 npm install）
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# /data/keys 供 entrypoint 持久化生成密钥；容器以非 root 的 node 用户运行
RUN chmod +x /app/entrypoint.sh && \
    mkdir -p /data/keys /app/logs && \
    chown -R node:node /data /app

EXPOSE 8081

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8081/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
