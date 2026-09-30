FROM node:26-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY knowledge ./knowledge
RUN npm run build && mkdir -p /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production CHAT_COACH_BETA_HOST=0.0.0.0 CHAT_COACH_BETA_PORT=8788 CHAT_COACH_DATA_DIR=/app/data
EXPOSE 8788
CMD ["node", "src/beta.mjs"]
