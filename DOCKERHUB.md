# OpenDockWatch

A small self-hosted Docker dashboard: containers grouped by Compose project, CPU/memory stats, start/stop/restart, live log tailing, and an ArgoCD-style topology view of how containers relate to each other. Works against the local Docker daemon and any number of remote hosts over SSH. No orchestration, no scheduling, no Kubernetes — just visibility and basic control, in the spirit of Dozzle.

[GitHub](https://github.com/DarkS1D3R/OpenDockWatch) · [Issues](https://github.com/DarkS1D3R/OpenDockWatch/issues) · [Full README](https://github.com/DarkS1D3R/OpenDockWatch#readme) · License: AGPL-3.0-or-later

## Quick start

```bash
mkdir -p config data
curl -o config/hosts.json https://raw.githubusercontent.com/DarkS1D3R/OpenDockWatch/main/config/hosts.example.json
curl -o .env https://raw.githubusercontent.com/DarkS1D3R/OpenDockWatch/main/.env.example
```

Generate a password hash for `.env`'s `AUTH_PASS_HASH` (no local Node.js needed — this runs it inside the image):

```bash
docker run --rm darks1d3r/opendockwatch node scripts/hash-password.js "your-password"
```

Fill in `.env` (`AUTH_USER`, the hash you just generated, and a random `SESSION_SECRET`), then run:

```bash
docker run -d --name opendockwatch \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ~/.ssh:/root/.ssh:ro \
  -v ./config:/app/config \
  -v ./data:/app/data \
  -v ./.env:/app/.env:ro \
  darks1d3r/opendockwatch
```

Visit `http://localhost:3000`.

Or with Compose:

```yaml
services:
  opendockwatch:
    image: darks1d3r/opendockwatch
    container_name: opendockwatch
    restart: unless-stopped
    ports:
      - '3000:3000'
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${HOME}/.ssh:/root/.ssh:ro
      - ./config:/app/config
      - ./data:/app/data
      - ./.env:/app/.env:ro
```

### Why these mounts

- `/var/run/docker.sock` — lets OpenDockWatch talk to the local Docker daemon (list, start/stop/restart, stats, logs). This is root-equivalent access to the host — treat this container like any other privileged admin tool, and don't expose it directly to the internet without a reverse proxy and additional access control.
- `~/.ssh` (read-only) — so the container's `docker` CLI can reach remote hosts over SSH using your existing key-based access, the same way you'd `ssh` in yourself.
- `./config`, `./data`, `./.env` — hosts config, the SQLite database (metrics/events/alerts history), and your environment config, all persisted outside the container.

## Features

- **List view** — containers grouped by Compose project, live CPU/memory columns, Start/Stop/Restart.
- **Flow view** — a topology graph with automatic edges for shared Docker networks (only across different Compose projects, to avoid clutter) and real Compose `depends_on` relationships, plus manually declared edges for anything Docker can't see itself. Live CPU/mem bars, network/disk rates, port badges, open-alert badges, a name filter, PNG export, and a Fullscreen toggle. Select a node to tint what it needs and what breaks if it dies, walking the real `depends_on` chain both directions. Collapse a Compose group to one aggregate box for large hosts, and zoom out to a compact view instead of shrinking metrics unreadable.
- **Details panel** — status, stats, ports, and `docker inspect` details (env vars, mounts, labels, restart policy) a click away — plus a full-width **log viewer** with level filters, live tailing over Server-Sent Events, and download.
- **Alerts** — container crashed / crash-looping / unhealthy / host unreachable out of the box, plus opt-in CPU / memory / disk-usage threshold rules. Optional push notification via webhook (Discord, ntfy, Gotify, Slack, or generic JSON).
- Works against the local socket and any number of remote hosts over SSH — no agents to install anywhere.

## Screenshots

![List view, containers grouped by Compose project](https://raw.githubusercontent.com/DarkS1D3R/OpenDockWatch/main/screenshots/list-view.png)

![Flow view, a topology graph of containers](https://raw.githubusercontent.com/DarkS1D3R/OpenDockWatch/main/screenshots/flow-view.png)

![Flow view with a node selected, tinting its upstream dependencies purple and downstream dependents orange](https://raw.githubusercontent.com/DarkS1D3R/OpenDockWatch/main/screenshots/flow-blast-radius.png)

![Flow view with a compose group collapsed into a single aggregate box showing container count, CPU/RAM, and health](https://raw.githubusercontent.com/DarkS1D3R/OpenDockWatch/main/screenshots/flow-collapsed.png)

![Container details panel with a live log preview and expanded environment/labels sections](https://raw.githubusercontent.com/DarkS1D3R/OpenDockWatch/main/screenshots/details-panel.png)

![Full-width log viewer pop-out with level filters](https://raw.githubusercontent.com/DarkS1D3R/OpenDockWatch/main/screenshots/log-viewer.png)

## Tags

- `latest` — most recent release
- `<version>` (e.g. `1.3.0`) — pinned to a specific release

Both built for `linux/amd64` and `linux/arm64`.

## Configuration

Minimum required in `.env`:

- `SESSION_SECRET` — random string that signs the session cookie
- `AUTH_USER` / `AUTH_PASS_HASH` — login credentials (see Quick start above for generating the hash)

Everything else — a second read-only login, remote SSH hosts, alert thresholds, webhook notifications, data retention — is optional and documented inline in [`.env.example`](https://raw.githubusercontent.com/DarkS1D3R/OpenDockWatch/main/.env.example) and [`config/hosts.example.json`](https://raw.githubusercontent.com/DarkS1D3R/OpenDockWatch/main/config/hosts.example.json).

## Full documentation

Setup details, remote-host configuration, the complete alerts/webhook reference, and the contributing guide live in the [README on GitHub](https://github.com/DarkS1D3R/OpenDockWatch#readme).

## License

AGPL-3.0-or-later — see [LICENSE](https://github.com/DarkS1D3R/OpenDockWatch/blob/main/LICENSE). Free to use, self-host, and modify, including internally within an organization. If you distribute a modified version, or run a modified version as a service that other people interact with over a network, you must make that modified source available to them under the same license.
