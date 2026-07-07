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
- Run `npm test` (a basic syntax check) locally; CI runs the same check.
- If you're adding a feature, a short note in the PR description on how you tested it is enough — there's no formal test suite yet.

## Reporting bugs

Open an issue with what you expected, what happened instead, and your `docker` / OS setup (local socket vs. SSH remote hosts) if relevant.
