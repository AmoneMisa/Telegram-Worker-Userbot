FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4100

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY index.js ./

EXPOSE 4100
CMD ["node", "index.js"]
