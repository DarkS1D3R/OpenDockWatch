# Hosts

How to add remote Docker hosts and Podman hosts, and how to run OpenDockWatch behind a reverse proxy. The [README](../README.md) has the quick start.

## How it works

The server shells out to the `docker` CLI rather than talking to the Engine API directly. For remote hosts it passes `-H ssh://user@host` per request, which the Docker CLI resolves using your normal SSH client/config/keys — no extra tunneling code needed. This means:

- Local host: no `dockerHost` set, uses the default local socket.
- Remote hosts: reachable via key-based SSH the same way you'd already `ssh` into them.
- Podman: through its Docker-compatible API, either as a socket or over SSH — see [Podman hosts](#podman-hosts).

Notes on `config/hosts.json`:

- `name` is optional for local (non-SSH) hosts — if omitted, it's auto-filled from the machine's real hostname via `docker info`. Remote SSH hosts still need an explicit `name` since there's no local machine to introspect.
- `config/hosts.json` is gitignored since it may contain internal hostnames — only `hosts.example.json` is committed.

## Remote hosts

Any host you can `ssh user@host` into (with a key, no password prompt) and that has a reachable Docker socket for that user can be added from the Settings panel or directly to `config/hosts.json`:

```json
{ "id": "prod", "name": "Production", "dockerHost": "ssh://deploy@prod.example.com" }
```

Recommended setup for a remote host:

- Create a **dedicated SSH key with no passphrase** for OpenDockWatch (`ssh-keygen -t ed25519 -f ~/.ssh/opendockwatch -N ""`) rather than reusing your personal key — a passphrase can't be entered by a non-interactive `docker` CLI call, so a passphrased key just hangs until it times out.
- Add the host's key to the known-hosts file before adding it here — `ssh-keyscan prod.example.com >> ~/.ssh/known_hosts` — so the first real connection doesn't hang on an interactive host-key prompt (`StrictHostKeyChecking ask` is `ssh`'s default, and there's nothing here to answer it).
- Use a **dedicated remote user in the `docker` group**, not `root` and not your own login, so it's obvious in the remote's own logs/audit trail which access is OpenDockWatch's.
- After adding a host, use its **Test connection** button in Settings — it runs the same reachability probe as the background poller but shows the actual `ssh`/`docker` error (`Host key verification failed`, `Permission denied (publickey)`, etc.) instead of just "unreachable".

**Connection reuse:** the container ships an `ssh_config.d` entry (`ControlMaster auto`, `ControlPersist 10m`) so the first `docker` call to a remote host opens one SSH connection and every call for the next 10 minutes — there are several per 5s poll — rides that same connection instead of opening its own. No configuration needed; this is why polling several remote hosts doesn't multiply into dozens of new SSH sessions a minute.

**Trust model:** SSH access to a host's Docker socket is root-equivalent on that host — anyone who can run arbitrary containers there can mount the host filesystem. Treat the dedicated key/user above with the same care as root SSH access, not as a limited-scope credential. For a genuinely least-privilege setup, look at [rootless Docker](https://docs.docker.com/engine/security/rootless/) on the remote host instead.

## Podman hosts

Podman works through its Docker-compatible API, so the same `docker` CLI inside the container talks to it. A Podman host is labelled **Podman** on the Hosts tab and its version reads "Podman 5.8.7" on the host card. Two ways to add one:

- **A socket on the same machine.** Enable the API socket (`sudo systemctl enable --now podman.socket` for rootful Podman, or `systemctl --user enable --now podman.socket` for rootless), mount it into the container and add a host with a `unix://` address:

  ```yaml
  volumes:
    - /run/podman/podman.sock:/run/podman/podman.sock # rootless: /run/user/<uid>/podman/podman.sock
  ```

  ```json
  { "id": "podman", "name": "Podman", "dockerHost": "unix:///run/podman/podman.sock" }
  ```

  On a machine with no Docker at all, mounting the Podman socket at `/var/run/docker.sock` and leaving `dockerHost` blank works too.

- **A remote host over SSH**, exactly like a Docker host (`ssh://user@host`). `docker -H ssh://` runs `docker system dial-stdio` on the remote, so the remote needs `docker` to mean Podman — install the `podman-docker` package, which provides that — and the API socket enabled for the SSH user as above. For a rootless user, also run `loginctl enable-linger <user>` so their socket and healthcheck timers keep running when nobody is logged in.

What is different from Docker, and how it is handled:

- **Health** is not in Podman's container list or its health events, so for a Podman host it is read with one `inspect` when Podman reports that a check ran — the health dot and an `unhealthy` alert can lag the check by one poll (5 seconds). Podman runs healthchecks from systemd timers; on a host without systemd they never run, and every container stays "starting".
- **`podman stop` sends no kill event**, so the `unexpected_exit` rule checks a few seconds later whether the restart policy brought the container back. If it stayed stopped, someone stopped it.
- Podman's extra `init`, `cleanup` and `exec` events are not shown, and its `remove` is shown as `destroy`, the same as a Docker host.

Tested against Podman 5.8, rootful, both through a mounted socket and over SSH.

## Reverse proxy

If you're putting OpenDockWatch behind a reverse proxy (nginx, Caddy, Traefik, etc.) that terminates TLS, set `TRUST_PROXY=true` in `.env` so Express trusts the proxy's `X-Forwarded-For`/`X-Forwarded-Proto` headers — this is needed for the session cookie's `Secure` flag and for the login rate limiter to see the real client IP rather than the proxy's.

Leave `TRUST_PROXY` unset (the default) if OpenDockWatch is reachable directly, without a proxy in front. Trusting `X-Forwarded-For` from an untrusted client lets them spoof `req.ip` on every request, which defeats the login rate limiter (each spoofed IP gets its own fresh attempt budget) and lets an attacker forge the IP recorded in `auth.failure` log lines.
