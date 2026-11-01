# Alerts

The full alert and webhook reference. The [README](../README.md) has the short version.

## Rules

OpenDockWatch fires an alert (visible in the Activity tab, and via `GET /api/alerts`) for these rules:

| Rule                | Fires when                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `container_crashed` | a container exits with a non-zero code (not from a manual stop/restart just before it)   |
| `unexpected_exit`   | a container with restart policy `always`/`unless-stopped` exits 0 without being asked to |
| `oom_killed`        | the kernel OOM-kills a process in a container (sent instead of `container_crashed`)      |
| `crash_loop`        | a container restarts 3+ times in 5 minutes, excluding manual restarts                    |
| `unhealthy`         | a container's healthcheck reports unhealthy                                              |
| `host_unreachable`  | a host stops responding to `docker version`                                              |
| `container_cpu`     | a container's CPU % stays over threshold for the sustain window                          |
| `container_mem`     | a container's mem % stays over threshold for the sustain window                          |
| `host_cpu`          | a host's normalized CPU % (sum of container CPU / core count) stays over threshold       |
| `host_mem`          | a host's summed container memory usage vs. total host memory stays over threshold        |
| `docker_disk`       | `docker system df`'s total footprint exceeds a threshold — see caveat below              |

The five threshold-based rules (`container_cpu`/`container_mem`/`host_cpu`/`host_mem`/`docker_disk`) are opt-in and disabled by default — set `ALERT_CPU_THRESHOLD`, `ALERT_MEM_THRESHOLD`, and/or `ALERT_DISK_THRESHOLD_GB` in `.env` (or from the Settings panel) to enable them. `ALERT_SUSTAIN_MINUTES` (default 5, shared between the CPU and mem rules) avoids alerting on a single spike from an image build, cron job, or JVM startup — a value has to stay over threshold continuously for that long before it fires.

A threshold breach raises one alert, however long it lasts; it no longer raises a new one every 10 minutes while it continues. [Reminders](#reminders-and-escalation) are the way to hear about it again.

## Caveats

- CPU % is raw `docker stats` CPU (per-core cumulative) — a container fully using 4 cores reads 400%, matching what the UI already shows. It is not normalized by core count.
- Mem % is `docker stats` MemPerc, computed against a container's own memory limit. A container with no limit set reads low against host total and rarely trips `container_mem` — in practice this focuses the rule on containers that do have limits, which is where memory pressure actually OOMKills.
- `docker_disk` is Docker's own footprint (images, containers, volumes, build cache) — Docker doesn't report host filesystem free space, so this can't be a true "disk almost full" alert. Treat it as a prune reminder.

## Per-container rules

- Skip threshold alerts for a single container entirely with the `opendockwatch.alerts=off` label (`docker run --label opendockwatch.alerts=off ...` or the equivalent in a compose file).
- Beyond that blanket label, admins can define per-container/name/compose-project alert rules from the Settings panel's **Container Rules** tab: an ordered list matched by container name (substring, case-insensitive) or an exact compose project, optionally scoped to one host, overriding the CPU/mem/sustain thresholds and/or muting individual event rules (`container_crashed`/`crash_loop`/`unhealthy`/`unexpected_exit`/`oom_killed`) for matched containers. The first matching rule wins in full — rules aren't merged together — and anything a matched rule leaves blank still inherits the global threshold above. No glob/regex matching. A muted event rule logs an `alert.muted` line instead of firing, so the Log Viewer still shows that something was suppressed and which rule did it.

## Webhooks

Set `ALERT_WEBHOOK_URL` in `.env` to also get a push notification on any of the rules above. The destination and payload are picked from the URL's scheme, so one config value is enough — no separate format setting per service:

| Scheme        | Example                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discord       | `discord://<webhook_id>/<webhook_token>`                                                                                                                                                         |
| ntfy          | `ntfy://ntfy.sh/mytopic` (or a self-hosted server: `ntfy://ntfy.example.com/mytopic`)                                                                                                            |
| Gotify        | `gotify://<host>/<token>` (http) or `gotifys://<host>/<token>` (https)                                                                                                                           |
| Slack         | any `https://hooks.slack.com/...` incoming webhook URL — auto-detected                                                                                                                           |
| Anything else | posted as generic JSON (the alert object). Set `ALERT_WEBHOOK_FORMAT=slack` to force the Slack `{text}` shape for a Slack-compatible endpoint that isn't on `hooks.slack.com` (e.g. Mattermost). |

**Resolved messages.** Set `ALERT_WEBHOOK_NOTIFY_RECOVERY=true` (or tick the box in Settings → Alerts → Webhook) to also get a message when a problem clears: a host reachable again, CPU/memory/disk back under its threshold, or a health check passing again. It says how long the problem lasted, goes only to destinations that received the original alert, and is labelled RESOLVED (sent at low priority on ntfy and Gotify). Crashes, crash loops, unexpected exits and OOM kills are one-off events and have no resolved message. Either way, the Activity tab marks an alert **resolved** with the time it cleared. Generic JSON payloads carry `status: "firing"` or `"resolved"`, plus `firedAt` on a resolved one.

**More than one webhook.** Settings → Alerts → Webhook → **Routes** adds extra destinations, each with a name, its own URL (any scheme above), and filters: one host or any, a set of rules or all of them, and warning-and-critical or critical only. Every enabled route whose filters match gets the alert — for example, `host_unreachable` and `oom_killed` to a phone via ntfy, and everything to a team chat. Each route has its own resolved-messages switch and a **Send test alert** button. Once a route exists, the main webhook can be set to receive only alerts that no route matched, so routes can take traffic away from it rather than only copying it. Every destination is retried on its own if it fails, for up to an hour; a retry of an alert that has resolved in the meantime is dropped rather than sent late.

## Reminders and escalation

An alert is sent once. Two settings follow up on one that nobody has acknowledged:

- **Reminders** — set `ALERT_REPEAT_MINUTES` (or Settings → Alerts → Webhook → _Remind every_) and a problem that is still there gets sent again at that interval, to every destination that received it, until someone acknowledges it in the Activity tab or it clears. The message starts "Still unacknowledged after 1h 30m:". Only conditions are repeated — a host still down, a container still unhealthy, a threshold still breached; crashes, crash loops, unexpected exits and OOM kills are one-off events and are not. Off by default.
- **Escalation** — give a route a delay ("Only after unacknowledged for 30 minutes") and it receives an alert only if nobody has acknowledged it by then, starting "Unacknowledged for 30m:". This applies to every rule, crashes included. A delayed route does not count as having taken the alert, so with the main webhook set to unmatched-only it still gets it at once. An alert is escalated within an hour of its delay passing or not at all, so adding an escalation route — or restarting after downtime — does not page about every old alert.
