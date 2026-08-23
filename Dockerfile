FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4100

RUN chown node:node /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json sample.env ./
COPY --chown=node:node index.js login.mjs env.mjs session.mjs ./
COPY --chown=node:node src ./src

USER node
EXPOSE 4100
CMD ["node", "index.js"]
