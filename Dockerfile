# Halcyon — Scramjet web proxy. Pure-JS server (no native deps); the Scramjet
# runtime is fetched from GitHub release tarballs during `npm install`.
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching. The Scramjet/controller tarball URLs in
# package.json are fetched here, so the builder needs network (Fly provides it).
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source (node_modules, .git, etc. excluded via .dockerignore).
COPY . .

# Bind publicly inside the container; Fly's proxy terminates TLS in front of it.
# HALCYON_PASSWORD is injected as a Fly secret at runtime (NOT baked in here) so
# the exposed instance isn't an open proxy.
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
