# Build stage — vite produces a static bundle.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# VITE_API_URL stays unset: an empty API_BASE makes the browser call
# same-origin relative URLs, which this image's nginx proxies to the API.
RUN npm run build

# Runtime stage — unprivileged nginx serving the bundle and proxying the API,
# Socket.io, and OAuth routes so the whole site is one origin.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1
