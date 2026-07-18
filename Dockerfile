FROM node:24-alpine AS deps

# better-sqlite3 has no prebuilt musl binary for this arch/version, so it compiles from
# source here; the toolchain stays in this stage and isn't copied into the final image.
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:24-alpine

RUN apk add --no-cache docker-cli openssh-client

# `docker -H ssh://...` just shells out to the system `ssh` binary, so it inherits this
# unmodified. Without it, every one of metricsCollector's ~4 docker calls per host per 5s poll
# opens (and tears down) its own SSH session - a real cost on a remote/high-latency host, and
# a fresh entry in the remote's auth log for every single one. ControlMaster turns the first
# call into a persistent master connection that every call for the next 10 minutes rides as a
# cheap multiplexed channel instead - no code changes needed, docker/ssh know nothing about this.
# ControlPath must live in /tmp (writable at runtime), not under ~/.ssh (mounted read-only - see
# the `docker run`/compose examples in README.md). Alpine's default /etc/ssh/ssh_config already
# `Include`s this directory, so dropping a file in is enough - see `ssh_config(5)`.
RUN mkdir -p /etc/ssh/ssh_config.d && \
    printf 'Host *\n  ControlMaster auto\n  ControlPath /tmp/odw-ssh-%%r@%%h-%%p\n  ControlPersist 10m\n  ServerAliveInterval 30\n' \
      > /etc/ssh/ssh_config.d/opendockwatch.conf

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
