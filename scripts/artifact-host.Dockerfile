ARG HOST_IMAGE
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS artifact-node
FROM ${HOST_IMAGE}
COPY --from=artifact-node /usr/local/bin/node /usr/local/bin/node
HEALTHCHECK NONE
USER node
