FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/webapp/package.json packages/webapp/
RUN npm install --workspace @rollomap/webapp --include-workspace-root
COPY packages/webapp ./packages/webapp
WORKDIR /app/packages/webapp
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY packages/webapp/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/webapp/dist /usr/share/nginx/html
EXPOSE 80
