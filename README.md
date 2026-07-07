# OpenDockWatch

A small self-hosted Docker dashboard: containers grouped by Compose project, CPU/memory stats, start/stop/restart, live log tailing, and an ArgoCD-style topology view of how containers relate to each other. Works against the local Docker daemon and any number of remote hosts over SSH. No orchestration, no scheduling, no Kubernetes — just visibility and basic control, in the spirit of Dozzle.

## Features

- **List view** — containers grouped by `docker compose` project (collapsible), with live CPU/memory columns and Start/Stop/Restart actions. Filter by All / Running / Stopped.
- **Flow view** — a graph of containers (grouped visually by compose project) with zoom/fit controls. Each node shows a state indicator (running / restarting / paused / stopped) in the top-left corner and an uptime/status string in the bottom-right. Edges are drawn two ways:
  - **Auto**: containers sharing a custom Docker network are connected (works with zero config for anything started via the same compose file).
  - **Manual**: declared in `hosts.json` (`edges: [{ from, to, label }]`) for relationships Docker can't see itself — e.g. a non-dockerized frontend calling a backend API, or cross-project dependencies.
- **Details panel** — clicking a container (in either view) opens a side panel with status, image, CPU/mem, ports, networks, actions, and a small live log preview (last 100 lines).
- **Log pop-out** — expand the preview into a full-width bottom panel with a tail-size selector (100/200/1000/5000 lines — capped, never loads unbounded history) and a live text filter.

## How it works

The server shells out to the `docker` CLI rather than talking to the Engine API directly. For remote hosts it passes `-H ssh://user@host` per request, which the Docker CLI resolves using your normal SSH client/config/keys — no extra tunneling code needed. This means:

- Local host: no `dockerHost` set, uses the default local socket.
- Remote hosts: reachable via key-based SSH the same way you'd already `ssh` into them.

## Requirements

- Node.js 20+
- `docker` CLI available on PATH, with access to the Docker socket
- For remote hosts: key-based SSH access (no password prompt) to a Docker socket on that host

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy env and hosts config:
   ```
   cp .env.example .env
   cp config/hosts.example.json config/hosts.json
   ```
3. Edit `config/hosts.json` with your real hosts (local + any remote SSH targets).
4. Generate a password hash and fill in `.env`:
   ```
   npm run hash-password -- "your-password"
   ```
   Put the output in `AUTH_PASS_HASH`, set `AUTH_USER`, and set a random `SESSION_SECRET`.
5. Run:
   ```
   npm start
   ```
   Visit http://localhost:3000

## Running as a container

You can also run OpenDockWatch itself in a container, alongside everything else it's monitoring:

```
docker compose up -d --build
```

This mounts `/var/run/docker.sock` for local control and `~/.ssh` (read-only) so the container's `docker` CLI can reach remote hosts over SSH the same way your host user would. If Docker runs inside WSL (rather than Docker Desktop), run this from within your WSL distro so the socket path lines up.

## Remote hosts

Any host you can `ssh user@host` into (with a key, no password prompt) and that has a reachable Docker socket for that user can be added to `config/hosts.json`:

```json
{ "id": "prod", "name": "Production", "dockerHost": "ssh://deploy@prod.example.com" }
```

## Notes

- `name` is optional for local (non-SSH) hosts — if omitted, it's auto-filled from the machine's real hostname via `docker info`. Remote SSH hosts still need an explicit `name` since there's no local machine to introspect.
- `config/hosts.json` is gitignored since it may contain internal hostnames — only `hosts.example.json` is committed.
- Logs are streamed via Server-Sent Events (`docker logs -f --timestamps`), stdout and stderr both included.
- Actions are limited to `start` / `stop` / `restart` — no `rm`, by design.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE). You're free to use, self-host, and modify OpenDockWatch, including internally within an organization. If you distribute a modified version, or run a modified version as a service that other people/users interact with over a network, you must make that modified source available to them under the same license.
