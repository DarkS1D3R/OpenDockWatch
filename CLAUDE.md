# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpenDockWatch is a small self-hosted Docker monitoring dashboard: container list/start/stop/restart, live log tailing, a topology ("Flow") graph, and an alerts/events feed. It watches the local Docker daemon and any number of remote hosts over SSH. See `README.md` for the full feature list and `CONTRIBUTING.md` for the release process.

## Commands

```
npm install                                 # deps
cp .env.example .env                        # then fill in AUTH_USER/AUTH_PASS_HASH/SESSION_SECRET
cp config/hosts.example.json config/hosts.json
npm run hash-password -- "your-password"    # generates a bcrypt hash for .env's AUTH_PASS_HASH

npm run dev                                  # node --watch server/index.js, http://localhost:3000
npm start                                    # plain node server/index.js

npm test                                     # syntax-check every server/public-js/scripts file, then node --test
node --test test/docker.test.js              # run a single test file
node --test --test-name-pattern="parseByteString" test/docker.test.js   # run one test by name

npm run lint                                 # eslint .
npm run format                               # prettier --write .
npm run format:check                         # prettier --check .  (what CI runs)

docker compose up -d --build                 # run OpenDockWatch itself in a container
```

CI (`.github/workflows/ci.yml`) runs `npm run lint && npm run format:check && npm test`, plus a parallel job that builds the image. Always run the same three before considering a change done.

**The image builds are cached, and which ones are is a deliberate split.** A cold build was measured at **~107s on a pruned builder**, nearly all of it `apk add python3 make g++` plus better-sqlite3 compiling from source — verified that it really does compile, by building without the toolchain and watching `prebuild-install` fail through to a node-gyp error, so the Dockerfile's comment about there being no musl prebuild is accurate. With a restored layer cache and only the source changed — the shape of a normal CI run — it drops to **~8s**. The two _verification_ builds (`ci.yml`'s `docker-build`, and the one inside `release.yml`'s prepare job) therefore use `cache-from`/`cache-to: type=gha` with `outputs: type=cacheonly`, since nothing consumes the image and it only has to build. **`mode=min`, not `mode=max`** — 82MB of cache against 200MB, and min _still_ reports `CACHED` for the deps stage's `apk` and `npm ci`, which reads wrong (min exports only the final image's layers) but is what buildkit actually does: it records enough of the chain for `COPY --from=deps` to hit without the intermediate stage's layers being exported. Both modes restored in the same ~8-10s, so `max` bought nothing for 118MB more cache. **The build that publishes to Docker Hub (`release-finalize.yml`) is deliberately left uncached**: it is the only build anyone pulls, it runs a handful of times a year, and GitHub evicts caches unused for 7 days, so it would usually be cold regardless.

## Code comments

A comment block attached to a function/method (or a magic number/config constant next to one) is capped at 3 lines. If the full rationale doesn't fit, keep the 3-line version terse and load-bearing, and put the rest in whichever of `server/CLAUDE.md` or `public/CLAUDE.md` covers that code instead of letting it spread across the codebase - those two files are the canonical home for the "why" behind most non-obvious decisions in this repo, so a comment can point there rather than repeat it.

## Two eslint environments

`eslint.config.js`: `server/**`, `scripts/**`, `test/**` are CommonJS/Node; `public/js/**` is an ES module/browser environment. Keep new files in the right bucket.

## Architecture

**The server shells out to the `docker` CLI** (`server/docker.js`) rather than talking to the Engine API or a Docker SDK — this is why remote hosts work at all: `-H ssh://user@host` is resolved by the Docker CLI itself using normal SSH key/config, so there's no separate tunneling code to maintain. **Staying responsive is a design constraint, not an optimization** — the failure this app has to avoid is the one where it's still running but unusable, since that's the one a container restart is the only cure for; every route/stream/poll-loop decision downstream of that is chosen to never leave a request unanswered, never multiply work per viewer, and recover without a human. Frontend is Vue 3 with no build step, served as native ES modules with no SFCs.

The codebase splits cleanly along the `server/` vs `public/` line, and so does the rest of this documentation:

- **Backend** — docker CLI shelling, the three background jobs (`eventWatcher`/`metricsCollector`/`statsWatcher`), `db.js`'s schema and soft-delete rules, `auth.js`, security headers, route input handling, the server-side half of the responsiveness rules → [`server/CLAUDE.md`](server/CLAUDE.md)
- **Frontend** — Vue component architecture, `public/js/lib/`'s pure modules, the log viewer's scroll-sync/pause/match-strip internals, theming, the client-side half of the responsiveness rules → [`public/CLAUDE.md`](public/CLAUDE.md)

Read whichever one matches the code you're actually touching; each is a standalone doc for its half of the app, with pointers back to the other where a topic spans both (e.g. SSE, the Settings panel, the client-error reporting route).
