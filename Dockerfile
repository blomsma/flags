FROM node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html control.html tsconfig.json vite.config.ts server.ts ./
COPY src ./src
COPY public ./public
RUN npm run build
FROM node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34 AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=4174 DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p /app/data && chown node:node /app/data
COPY --from=build /app/dist ./dist
COPY server.ts ./
COPY src/shared ./src/shared
COPY docs ./docs
COPY seed ./seed
USER node
EXPOSE 4174
CMD ["node", "--import", "tsx", "server.ts"]
