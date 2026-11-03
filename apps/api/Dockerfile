# Збірка з кореня репозиторію: docker build -f apps/api/Dockerfile .
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @pid/api --include-workspace-root=false
COPY packages/core packages/core
COPY apps/api apps/api
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
CMD ["npx", "tsx", "apps/api/src/server.ts"]
