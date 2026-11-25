# Compose scripts

Run your own script when someone presses **Start all** or **Stop all** on a compose group, instead of OpenDockWatch's built-in batch action. The [README](../README.md) has the quick start.

## What it does

The List view shows a **Start all** / **Stop all** row on each compose group's header. Without a script, these buttons start or stop each container in the project one by one, in `depends_on` order (see [features](features.md)). With a script in place, the same button runs your script instead.

Use a script when the batch action isn't enough, for example to:

- run a backup before stopping a database,
- pull new images before starting,
- recreate containers rather than restart the old ones.

Limits in this first version:

- **Local host only.** This means a host with no `dockerHost` in `config/hosts.json`. Remote SSH hosts always use the batch action.
- **Start and stop only.** **Restart all** always uses the batch action.
- **No `docker compose` in the image.** The OpenDockWatch image ships the `docker` CLI, `bash` and `ssh`, but not the compose plugin. See [Writing a script](#writing-a-script) for what that means.

## Setup

### 1. Create the scripts folder

One folder per host, then one per compose project, each holding `start.sh` and/or `stop.sh`:

```
compose-scripts/
└── local/              # the host id from config/hosts.json
    ├── shop/           # the compose project name
    │   ├── start.sh
    │   └── stop.sh
    └── billing-api/
        └── stop.sh     # no start.sh: Start all uses the batch action
```

- The **host id** is the `id` field in `config/hosts.json`, not its display name.
- The **project name** is the compose project, as shown on the group header in the List view. It is the `com.docker.compose.project` label, usually the folder the compose file lives in. Compose project names are lowercase letters, digits, `-` and `_`; a folder with any other name is ignored.
- A missing file means that action falls back to the batch. You can add a script for just one of the two.

### 2. Point OpenDockWatch at it

In `.env`:

```
COMPOSE_SCRIPTS_DIR=/app/compose-scripts
# Optional: how long a script may run before it is killed. Default 300000 (5 minutes).
COMPOSE_SCRIPT_TIMEOUT_MS=
```

If OpenDockWatch runs in Docker, mount the folder. `docker-compose.yml` has the line ready to uncomment:

```yaml
volumes:
  - ./compose-scripts:/app/compose-scripts:ro
```

If you run it with `npm start`, set `COMPOSE_SCRIPTS_DIR` to the folder's real path instead.

Restart OpenDockWatch after changing `.env`. You don't need to restart after adding, editing or removing a script: it's looked up fresh on every button press.

## Writing a script

### What the script gets

| Variable                                    | Value                                                         |
| ------------------------------------------- | ------------------------------------------------------------- |
| `ODW_HOST_ID`                               | The host id, e.g. `local`                                     |
| `ODW_COMPOSE_PROJECT`                       | The project name, e.g. `shop`                                 |
| `ODW_ACTION`                                | `start` or `stop`                                             |
| `PATH`, `HOME`, `LANG`, `TZ`, `DOCKER_HOST` | Passed through from OpenDockWatch's own environment, when set |

Nothing else from OpenDockWatch's environment reaches the script, and in particular nothing from `.env`, which holds the session secret and password hashes. If a script needs a secret, keep it in a file next to the script and read it from there.

The script runs:

- **in its own folder** (`compose-scripts/<host>/<project>/`), so relative paths start there,
- **inside the OpenDockWatch container** when you run it in Docker, with the same Docker socket OpenDockWatch uses,
- **through its shebang** (`#!/bin/bash`, `#!/bin/sh`) when it has the exec bit set, and through `/bin/sh` when it doesn't. Bind mounts from Windows often lose the exec bit, so add a shebang and `chmod +x` where you can.

### Exit code and output

- **Exit 0** is success. Anything else, a timeout, or failing to start at all is a failure.
- When a script fails, the List view shows its **last line of output** as the error. Make that line say what went wrong.
- Output (stdout and stderr together) is kept up to the last 16 KiB. On failure, the end of it is saved on the run's audit rows in **Settings > Audit**.
- At `COMPOSE_SCRIPT_TIMEOUT_MS` the script and every process it started are killed.

### Example: plain `docker` (works in the image as it ships)

Without the compose plugin, act on the project's containers by their compose label:

```bash
#!/bin/bash
# stop.sh - back up the database, then stop the project's containers.
set -euo pipefail

docker exec shop-db pg_dump -U shop shop > "backups/shop-$(date +%Y%m%d-%H%M%S).sql"

ids=$(docker ps -q --filter "label=com.docker.compose.project=$ODW_COMPOSE_PROJECT")
[ -z "$ids" ] && { echo "nothing running in $ODW_COMPOSE_PROJECT"; exit 0; }
docker stop $ids
```

```bash
#!/bin/bash
# start.sh - start the project's stopped containers, database first.
set -euo pipefail

docker start shop-db
sleep 5
docker start $(docker ps -aq --filter "label=com.docker.compose.project=$ODW_COMPOSE_PROJECT")
```

For the backup above to land somewhere, `backups/` must be writable, so the mount can't be `:ro`. Mount a separate writable folder for it, or write the backup somewhere else.

### Example: `docker compose` (needs the compose plugin)

This works when OpenDockWatch runs with `npm start` on a machine that has `docker compose` and the compose file. It does not work in the image yet.

```bash
#!/bin/bash
# start.sh
set -euo pipefail
cd /srv/shop
docker compose pull
docker compose up -d
```

```bash
#!/bin/bash
# stop.sh
set -euo pipefail
cd /srv/shop
docker compose stop
```

### Use `stop`, not `down`

In a stop script, use `docker compose stop`, or `docker stop` on the containers, and never `docker compose down`. `down` removes the containers, and OpenDockWatch builds compose groups from existing containers, so the group disappears from the list along with its **Start all** button. You'd have nothing to press to bring it back.

## Using it

1. Press **Start all** or **Stop all** on the group. There's no separate button or badge: if a script exists for that action, it runs.
2. The group's buttons stay disabled until the script exits. Close the tab if you like: the script keeps running on the server, and closing the tab doesn't stop it.
3. When it finishes, the list refreshes. A failure shows as an error above the list, e.g. `stop script for shop failed (exit 1): no such container: shop-db`.

While a script is running for a project, any other start, stop or restart on that project is refused with "a script is still running" until it finishes.

## Who can run them

- **Admin login:** can run scripts and see their output.
- **Viewer login:** can't press the buttons, and can't read the status or output.

Anyone who can put files in the scripts folder can run commands as OpenDockWatch with access to the Docker socket. That's effectively root on the host. Keep the folder writable only by people you'd give that to, and mount it read-only.

## Alerts and the audit log

A scripted stop doesn't raise **container crashed** alerts. Before the script starts, OpenDockWatch writes a `pending` audit row for each container in the project, the same rows a batch action writes. That's what tells the alert engine the stop was asked for. When the script exits, those rows turn `ok` or `error`.

The rows are written for the containers that exist when you press the button. A container the script creates afresh gets no row of its own.

## Troubleshooting

| Symptom                              | Check                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Button still does the batch action   | `COMPOSE_SCRIPTS_DIR` is set, and OpenDockWatch was restarted after setting it. The folder is `<host id>/<project>/`, with the exact names. The file is `start.sh`/`stop.sh`. The host is local. |
| `failed (exit 127)`                  | A command isn't installed in the container, often `docker compose` (see [above](#example-docker-compose-needs-the-compose-plugin)) or a tool the script expects.                                 |
| `failed (spawn ENOENT)`              | The shebang names an interpreter the container doesn't have. Use `#!/bin/bash` or `#!/bin/sh`.                                                                                                   |
| `failed (exit 2)` with `can't open`  | The file isn't readable by the user OpenDockWatch runs as.                                                                                                                                       |
| `failed (timed out)`                 | The script ran past `COMPOSE_SCRIPT_TIMEOUT_MS`. Raise it, or make the script quicker.                                                                                                           |
| The group vanished after Stop all    | The script used `docker compose down`. Start the project from a shell, and change the script to `stop`.                                                                                          |
| Script works in a shell but not here | It relies on an environment variable your shell has. Only the variables listed [above](#what-the-script-gets) are passed in.                                                                     |
