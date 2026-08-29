# Build stage
FROM node:20-slim as build-stage

WORKDIR /app

COPY package*.json ./
# npm ci + lockfile：可复现构建（勿改回 npm install）
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM nginx:stable-alpine as production-stage

COPY --from=build-stage /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
