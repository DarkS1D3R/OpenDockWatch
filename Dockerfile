FROM node:24-alpine AS deps

# better-sqlite3 has no prebuilt musl binary for this arch/version, so it compiles from
# source here; the toolchain stays in this stage and isn't copied into the final image.
RUN apk add --no-cache python3 make g++

WORKDIR /app
# The lockfile comes along so this is `npm ci` rather than `npm install` - the image then gets
# exactly the dependency tree CI linted and tested against, instead of whatever transitive
# versions happen to resolve on the day the image is built.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The Docker CLI comes from Docker's own image rather than Alpine's docker-cli package. The CLI is
# a Go binary, so image scanners attribute every Go standard-library CVE to it, and Alpine's build
# lags Docker's: alpine/v3.24/community was still shipping 29.5.3 built with go1.26.3 while this
# image had 29.6.2 built with go1.26.5 - the difference between carrying CVE-2026-42504,
# CVE-2026-27145 and CVE-2026-42507 (all Go stdlib, all fixed in go1.26.4) and not. Rebuilding
# against Alpine could not fix that; only Alpine rebuilding the package could.
#
# The tag floats within the 29.x line on purpose: a rebuild should pick up the CLI's own patches,
# which is the whole point. Bump the major deliberately, and check `docker --version` still
# reports what you expect afterwards. The binary is self-contained and runs as-is on this musl
# base - it needs nothing else copied alongside it.
FROM docker:29-cli AS dockercli

FROM node:24-alpine

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

RUN apk add --no-cache openssh-client

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
# express changes behaviour on this (view caching, and notably its default error handler stops
# putting stack traces in response bodies) - the app should never run as anything else in an image.
ENV NODE_ENV=production
EXPOSE 3000

# GET /healthz (server/index.js) checks two things, neither of which touches the Docker CLI: a
# trivial sqlite query, and whether the metrics poll loop is still turning (see watchdog.js). A
# slow/unreachable *remote* SSH host has no business flapping this container's own health, and it
# doesn't - an unreachable host still completes its poll normally, so only the loop itself having
# stopped can fail this. Note that Docker never restarts a container for being unhealthy; this
# reports, and watchdog.js's self-exit is what actually recovers a wedged instance via the restart
# policy. node over curl/wget: curl isn't installed and busybox wget's flag/exit-code behaviour
# differs across Alpine versions, where a two-line http.get is unambiguous and needs nothing extra.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
