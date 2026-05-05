FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/api/package.json packages/api/
RUN npm install --workspace @rollomap/api --include-workspace-root

COPY packages/api ./packages/api
COPY db ./db

WORKDIR /app/packages/api
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
