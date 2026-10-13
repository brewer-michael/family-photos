# syntax=docker/dockerfile:1
#
# Family Photos: the web app, its two media worker lanes and the media tools in one image.
# Both stages use the same base image, so the native modules npm installs in the build stage
# (better-sqlite3, sharp's libvips) match the runtime's Node.js and glibc exactly.
# Built, smoke-tested and pushed by .github/workflows/docker.yml; see README.md to run it.

ARG NODE_IMAGE=node:24-trixie-slim

# --- build: the app (build/) and the worker (build-worker/), then production dependencies only
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency needs an install script. npm (10 and 11) would otherwise run
# `node-gyp rebuild` for better-sqlite3, which fails here for lack of Python and a compiler,
# although the package ships ready-made Node-API binaries (prebuilds/) and loads them by itself.
# sharp's binaries are npm packages.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
# npm installs the musl (Alpine) builds of the native packages next to the glibc ones, and
# better-sqlite3 carries binaries for every platform. On this glibc image sharp, lightningcss and
# rolldown load their linux-<arch>(-gnu) package and better-sqlite3 its prebuilds/linux-<arch>.node,
# so the rest goes. The last line fails the build if the two native modules the app uses don't load.
RUN rm -rf node_modules/@img/sharp-linuxmusl-* node_modules/@img/sharp-libvips-linuxmusl-* \
           node_modules/@rolldown/binding-*-musl node_modules/lightningcss-*-musl \
 && find node_modules/better-sqlite3/prebuilds -type f ! -name "linux-$(node -p process.arch).node" -delete \
 && node -e "new (require('better-sqlite3'))(':memory:').close(); require('sharp')"

# --- runtime
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="Family Photos" \
      org.opencontainers.image.description="A private place for a family to share photos and videos, self-hosted on Unraid." \
      org.opencontainers.image.source="https://github.com/brewer-michael/family-photos" \
      org.opencontainers.image.url="https://github.com/brewer-michael/family-photos" \
      org.opencontainers.image.documentation="https://github.com/brewer-michael/family-photos#readme" \
      org.opencontainers.image.licenses="MIT"

# The media tools (docker/media-tools.sh, which CI's media-parity job installs too), tini as PID 1,
# tzdata for the TZ Unraid passes in, and CA certificates. setpriv and ionice are already in the
# base image (util-linux). The check fails the build if a tool lacks a feature the lanes need.
RUN --mount=type=bind,source=docker/media-tools.sh,target=/tmp/media-tools.sh \
    sh /tmp/media-tools.sh install tini tzdata ca-certificates \
 && sh /tmp/media-tools.sh check

# Fixed for the container (see .env.example); the Unraid template sets everything else.
ENV NODE_ENV=production \
    PORT=3000 \
    PROTOCOL_HEADER=x-forwarded-proto \
    BODY_SIZE_LIMIT=64M \
    CONFIG_DIR=/config \
    PHOTOS_DIR=/photos \
    UV_THREADPOOL_SIZE=8

# Owned by root and read-only to the app user (PUID).
WORKDIR /app
COPY --from=build /app/package.json /app/server.js ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/build-worker ./build-worker
COPY --chmod=0755 docker/entrypoint.sh /entrypoint.sh

VOLUME ["/config", "/photos"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=2m --start-interval=5s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
CMD ["node", "server.js"]
