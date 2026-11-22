FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
ENV HOST=0.0.0.0 DATA_DIR=/data NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null || exit 1
CMD ["node", "server.js"]
