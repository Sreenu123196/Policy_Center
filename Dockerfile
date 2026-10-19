# PolicyCenter Simulator. Not built or run in the project's own checks (no Docker on the development machine): build it once and
# check /api/health before relying on it.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# The data (and its backups) live in a volume, never in the image.
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/policycenter.json BACKUP_DIR=/data/backups
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
