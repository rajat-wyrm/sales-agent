# Production image: compiled dist + prod deps only, plain `node` (no tsx JIT at
# runtime, so boots faster and uses less memory than the old dev-mode runner).
FROM node:22-alpine AS builder
WORKDIR /build

COPY package*.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --legacy-peer-deps --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/database ./database

EXPOSE 3000
CMD ["node", "dist/watch.js"]
