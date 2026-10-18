# The API as a container image. Build: docker build -t insurance-suite-api .
# Two stages: the first compiles the TypeScript, the second holds only what is needed to run.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The migrations and the configuration are files the server reads at start-up.
COPY db ./db
COPY config ./config
USER node
EXPOSE 3000
# The server listens on all addresses inside the container; the port is published by docker or the platform.
ENV HOST=0.0.0.0 PORT=3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/api/server.js"]
