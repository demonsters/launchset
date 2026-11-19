FROM node:24-alpine
WORKDIR /app
COPY . .
RUN npx turbo run build --filter=digests
CMD ["node", "apps/digests/index.js"]
