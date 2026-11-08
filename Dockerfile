FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json build.js ./
COPY src ./src
COPY content ./content
COPY server ./server
RUN node build.js && mkdir -p /app/data && chown -R node:node /app/data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5198 WORKSHOP_DATA_DIR=/app/data
USER node
EXPOSE 5198
CMD ["node", "server/index.mjs"]
