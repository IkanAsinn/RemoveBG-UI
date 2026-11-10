# syntax=docker/dockerfile:1

# Build stage follows the runner's architecture: the output is static files, so it never needs emulation.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Models are fetched at build time and verified against the manifest (sha256 + licence guard). They come before the
# source copy, so this ~183 MB layer stays cached until the manifest changes.
COPY src/model/manifest.json src/model/manifest.json
COPY scripts/models.mjs scripts/models.mjs
RUN npm run models:fetch

COPY . .
# `prebuild` re-checks the models; the audit fails the image on eval, trackers, external scripts or CDN assets (NFR-18).
RUN npm run build && npm run audit:dist

FROM nginx:1.29-alpine AS final

# Static SPA: everything runs in the browser (NFR-1). nginx adds the cross-origin isolation headers to every response,
# 304s included (see nginx.conf and docs/browser-matrix.md).
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
