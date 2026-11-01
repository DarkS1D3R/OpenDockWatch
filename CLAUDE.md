# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpenDockWatch is a small self-hosted Docker monitoring dashboard: container list/start/stop/restart, live log tailing, a topology ("Flow") graph, and an alerts/events feed. It watches the local Docker daemon and any number of remote hosts over SSH. See `README.md` for an overview, `docs/` for the full feature, host and alert reference, and `CONTRIBUTING.md` for the release process.

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

**The image's deps stage runs `npm ci --ignore-scripts` with no build toolchain, and deletes the better-sqlite3 prebuilds for other platforms.** Don't add `apk add python3 make g++` back, and don't drop `--ignore-scripts`. The CI verification builds use the gha cache with `mode=min`. The Docker Hub publish build is deliberately uncached. The reasons and the build-time numbers are in [`docs/architecture/server.md`](docs/architecture/server.md#docker-image-build-toolchain-and-ci-cache).

## Code comments

A comment block attached to a function/method (or a magic number/config constant next to one) is capped at 3 lines. If the full rationale doesn't fit, keep the 3-line version terse and load-bearing and put the rest in [`docs/architecture/server.md`](docs/architecture/server.md) or [`docs/architecture/frontend.md`](docs/architecture/frontend.md), whichever covers that code. Those two files are the canonical home for the "why" behind non-obvious decisions, so a comment points there instead of repeating it.

The CLAUDE.md files hold **rules only**: one or two lines per invariant, saying what must stay true. A new decision gets its rationale in `docs/architecture/`, under the section for that subsystem. It gets a CLAUDE.md line only if breaking it would be a bug, and then it links the section. Don't let a CLAUDE.md file grow back into a design log. It is loaded into every session that touches that folder.

## Example names in tests and docs

Test fixtures, code comments, and docs (`README.md`, the CLAUDE.md files, `docs/architecture/`) use generic example names — `myorg/billing-api`, `acme-corp-*`, `shop`, `web` — never the maintainer's own projects, clients, hostnames or paths, even when a real deployment is what prompted the change. This is a public repo; describe the _shape_ of the case ("a custom image built `FROM eclipse-temurin` with `SPRING_*` env") rather than whose it was.

## Two eslint environments

`eslint.config.js`: `server/**`, `scripts/**`, `test/**` are CommonJS/Node; `public/js/**` is an ES module/browser environment. Keep new files in the right bucket.

## Architecture

**The server shells out to the `docker` CLI** (`server/docker.js`) rather than talking to the Engine API or a Docker SDK — this is why remote hosts work at all: `-H ssh://user@host` is resolved by the Docker CLI itself using normal SSH key/config, so there's no separate tunneling code to maintain. **Staying responsive is a design constraint, not an optimization** — the failure this app has to avoid is the one where it's still running but unusable, since that's the one a container restart is the only cure for; every route/stream/poll-loop decision downstream of that is chosen to never leave a request unanswered, never multiply work per viewer, and recover without a human. Frontend is Vue 3 with no build step, served as native ES modules with no SFCs.

The codebase splits along the `server/` vs `public/` line, and so do the docs. Each half has a rule sheet that loads automatically when you work in that folder, and a rationale doc to read on demand:

- **Backend**: [`server/CLAUDE.md`](server/CLAUDE.md) (rules) and [`docs/architecture/server.md`](docs/architecture/server.md) (why). Covers docker CLI shelling, the background jobs, alerts/webhooks, `db.js` schema and soft deletes, auth, security headers, route input, and the server half of the responsiveness rules.
- **Frontend**: [`public/CLAUDE.md`](public/CLAUDE.md) (rules) and [`docs/architecture/frontend.md`](docs/architecture/frontend.md) (why). Covers the Vue components, `public/js/lib/`, the log viewer, theming, accessibility, and the client half of the responsiveness rules.

Both rationale docs open with a table of contents. Grep them for the module or function you are touching.
