FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY mcp ./mcp
ENV HOST=0.0.0.0 PORT=4317 GTD_DATA=/data NODE_ENV=production
VOLUME /data
EXPOSE 4317
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
