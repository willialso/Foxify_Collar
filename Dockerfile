FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN npm run build

RUN mkdir -p /app/logs

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

EXPOSE 8000

CMD ["node", "dist/server.js"]
