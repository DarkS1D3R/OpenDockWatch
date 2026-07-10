FROM node:24-alpine AS deps

# better-sqlite3 has no prebuilt musl binary for this arch/version, so it compiles from
# source here; the toolchain stays in this stage and isn't copied into the final image.
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:24-alpine

RUN apk add --no-cache docker-cli openssh-client

# npm ships inside the base image but nothing at runtime uses it - CMD calls node
# directly, and node_modules was already installed in the deps stage above. Dropping it
# removes its bundled undici/tar (flagged CVEs in code that's never executed here)
# instead of carrying them in the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
