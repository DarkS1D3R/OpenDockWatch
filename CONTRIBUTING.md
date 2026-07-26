# Contributing

Issues and pull requests are welcome.

## Development setup

```
npm install
cp .env.example .env
cp config/hosts.example.json config/hosts.json
npm run hash-password -- "your-password"   # put the output in .env's AUTH_PASS_HASH
npm run dev
```

## Before opening a PR

- Keep changes focused — separate unrelated fixes into separate PRs.
- Run `npm test` (syntax check + unit tests), `npm run lint`, and `npm run format:check` locally; CI runs the same checks. `npm run format` applies Prettier's fixes for you.
- Unit tests (`node:test`, in `test/`) cover the pure parsing/graph functions and the alert rules - add to them when you touch that code. There's no end-to-end test suite, so for feature PRs a short note in the description on how you tested it is still appreciated.

## Screenshots

The README/DOCKERHUB screenshots come from a throwaway stack, not from anyone's real containers:

```
scripts/demo-stack.sh up --isolated     # two compose projects inside a private Docker daemon
scripts/demo-stack.sh down --isolated   # remove it again
```

`--isolated` builds the stack inside a docker-in-docker container and prints how to point
OpenDockWatch at that daemon's socket. It's worth the extra step for screenshots: the List view's
Running filter hides stopped containers, but the Flow graph and the container count still include
them, so filtering alone won't keep unrelated containers out of a shot. Drop the flag to build the
stack on the current daemon instead, which is the more useful form for just developing against
something that has more than one container in it.

The stack deliberately contains an unhealthy container, a crash-looping one, and one that has
exited, so the health dots, restart badges and alert rules all have something to show. Leave it
running a while before shooting — the host card's chart covers 30 minutes, and the row sparklines
fill from an in-memory buffer over the first couple of minutes after a page load.

## Reporting bugs

Open an issue with what you expected, what happened instead, and your `docker` / OS setup (local socket vs. SSH remote hosts) if relevant.

## Releasing (maintainers)

Releases go through a branch + PR, in two automated steps:

1. **[Release](.github/workflows/release.yml)**: Actions → Release → Run workflow, with the target version (plain semver, e.g. `1.2.0`). It re-runs the full CI suite plus a Docker build against `develop`, creates `release/<version>` off `develop`, bumps `package.json`/`package-lock.json` on it, pushes the branch, and opens a PR into `main`. Tick "dry run" to validate everything (tests, build, the branch + version bump) without pushing or opening a PR.
2. Review and merge that PR **with "Create a merge commit"** (not squash/rebase), same as branch-protection rules on `main` would require anyway.
3. **[Release Finalize](.github/workflows/release-finalize.yml)** runs automatically once the `release/*` PR is merged, as three jobs:
   - `finalize`: tags the merge commit, publishes a GitHub Release with notes built from the commit log since the previous tag (a flat bulleted list of commit subjects - `gh release create --generate-notes` groups by merged PR, which doesn't work well here since feature work goes straight to `develop` rather than one PR per feature), opens a second PR (`chore/sync-develop-<version>`) to merge `main` back into `develop` and sets it to auto-merge, and deletes the release branch. That second PR goes through `develop`'s normal branch protection instead of a direct push, so it'll sit waiting if `develop` requires reviews - merge it manually if auto-merge doesn't fire on its own.
   - `docker-build`: builds the Docker image per architecture, each on a native runner for that arch (`ubuntu-latest` for amd64, `ubuntu-24.04-arm` for arm64) and pushes it to Docker Hub by digest. Native runners rather than QEMU emulation because `node:24-alpine` has no prebuilt musl binary for `better-sqlite3`, so it always compiles from source - doing that under QEMU for arm64 is painfully slow.
   - `docker-manifest`: combines the two digests into the real `darks1d3r/opendockwatch:<version>` and `:latest` multi-arch tags.

Requires the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repo secrets (a Docker Hub access token, not your account password).
