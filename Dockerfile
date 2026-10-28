FROM oven/bun:1-alpine

RUN apk add --no-cache openjdk21-jre lcms2

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV MCP_PORT=3000

VOLUME ["/data"]
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
