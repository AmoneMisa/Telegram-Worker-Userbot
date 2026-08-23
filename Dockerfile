FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4100

# The worker persists worker.env/session refreshes and its photo cache below
# /app, so keep the directory writable while dropping root privileges.
RUN chown node:node /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node index.js env.mjs session.mjs ./
COPY --chown=node:node src ./src

USER node
EXPOSE 4100
CMD ["node", "index.js"]
