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

## Reporting bugs

Open an issue with what you expected, what happened instead, and your `docker` / OS setup (local socket vs. SSH remote hosts) if relevant.

## Releasing (maintainers)

Releases go through a branch + PR, in two automated steps:

1. **[Release](.github/workflows/release.yml)**: Actions → Release → Run workflow, with the target version (plain semver, e.g. `1.2.0`). It re-runs the full CI suite plus a Docker build against `develop`, creates `release/<version>` off `develop`, bumps `package.json`/`package-lock.json` on it, pushes the branch, and opens a PR into `main`. Tick "dry run" to validate everything (tests, build, the branch + version bump) without pushing or opening a PR.
2. Review and merge that PR **with "Create a merge commit"** (not squash/rebase), same as branch-protection rules on `main` would require anyway.
3. **[Release Finalize](.github/workflows/release-finalize.yml)** runs automatically once the `release/*` PR is merged: it tags the merge commit, publishes a GitHub Release with auto-generated notes, merges `main` back into `develop` so the version bump isn't left behind, and deletes the release branch.
