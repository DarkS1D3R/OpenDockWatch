# Security Policy

OpenDockWatch mounts the Docker socket and (optionally) your SSH keys, and can start/stop/restart containers on any host you configure. Treat it like any other privileged admin tool — don't expose it directly to the internet without a reverse proxy and additional access controls.

## Supported versions

Only the latest tagged release is supported. Fixes land on `main` and are cut into a new tag; there are no maintained older branches.

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Instead, use [GitHub's private vulnerability reporting](../../security/advisories/new) for this repository (Security tab → "Report a vulnerability"). If that's not available, reach out to a maintainer directly via a GitHub DM rather than a public issue or PR.

Include what you'd normally include in a report: affected version/commit, reproduction steps, and impact. You should get an initial response within a few days.

## Scope notes

- Auth is a single shared username/password (bcrypt-hashed) plus a signed session cookie — there's no per-user RBAC. Don't share the login broadly.
- Actions are intentionally limited to `start` / `stop` / `restart` (no `rm`, no arbitrary exec), but anyone with the login can still stop/restart anything on any configured host.
- Remote hosts are reached via the `docker` CLI over SSH using your local SSH config/keys — anyone who can reach the OpenDockWatch process can act as that SSH identity against those hosts.
