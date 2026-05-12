FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --production && npm cache clean --force

COPY . .

RUN chmod +x /app/entrypoint.sh

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8081/v1/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
