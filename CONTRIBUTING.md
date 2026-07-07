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
