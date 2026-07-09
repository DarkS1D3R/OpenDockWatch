FROM node:24-alpine AS deps

# better-sqlite3 has no prebuilt musl binary for this arch/version, so it compiles from
# source here; the toolchain stays in this stage and isn't copied into the final image.
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:24-alpine

RUN apk add --no-cache docker-cli openssh-client

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
