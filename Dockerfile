FROM node:24.15.0-bookworm-slim AS base
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
COPY assets ./assets
COPY plugin ./plugin
COPY docs ./docs
COPY README.md ./
COPY biome.json ./
COPY AGENTS.md Company-Agent-Memory-Implementation-Spec.md ./

FROM base AS test
RUN npm run typecheck
RUN npm run lint
RUN npm run check:structure
RUN npm run test:core
RUN npm run check:docs
RUN npm run build

FROM base AS build
RUN npm run build
