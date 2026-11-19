FROM node:24-alpine
WORKDIR /app
COPY . .
RUN npx turbo run build --filter=web
CMD ["node", "apps/web/server.js"]
