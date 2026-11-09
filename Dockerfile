FROM oven/bun:1.3.13 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig*.json vite.config.ts index.html ./
COPY server ./server
COPY src ./src
COPY public ./public
RUN bun run build

FROM oven/bun:1.3.13
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
RUN mkdir -p /app/data && chown bun:bun /app/data
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
