FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4100

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY index.js env.mjs session.mjs ./

# Run the network-facing worker without root privileges. /app must stay writable
# because the worker may persist worker.env and its bounded photo cache there.
RUN chown -R node:node /app
USER node

EXPOSE 4100
CMD ["node", "index.js"]
