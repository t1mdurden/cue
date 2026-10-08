FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# The renderer loads Silero VAD + ONNX Runtime from node_modules at /vendor/* (see src/server.js).
RUN mkdir -p /data && chown node /data
ENV NODE_ENV=production
EXPOSE 8787
USER node
CMD ["node", "src/server.js"]
