#!/bin/sh
# A throwaway stack of containers to point OpenDockWatch at - for taking the README screenshots,
# and for looking at any view that needs more than one container to mean anything.
#
#   scripts/demo-stack.sh up              # create it on the current Docker daemon
#   scripts/demo-stack.sh up --isolated   # create it inside a private daemon instead
#   scripts/demo-stack.sh down            # remove everything it created
#   scripts/demo-stack.sh down --isolated
#
# --isolated runs a docker-in-docker container and builds the stack inside that, so the machine's
# own containers stay out of frame. That matters for screenshots specifically: the List view's
# Running filter would hide stopped containers, but the Flow graph and the container count still
# include them, so filtering is not enough to keep unrelated containers out of a shot.
#
# Two design notes worth knowing before editing:
#
#   * The compose labels are set by hand on plain `docker run` containers rather than written as a
#     compose file. OpenDockWatch groups by com.docker.compose.project and draws its dependency
#     edges from com.docker.compose.depends_on, so setting those directly gives exact control over
#     the topology - and it needs no compose binary inside the isolated daemon.
#
#   * There are deliberately two projects. With one, "Collapse all" in the Flow view produces a
#     single aggregate box that demonstrates nothing, and automatic network edges are suppressed
#     within a project by design, so the graph draws none at all. The two share one network
#     (shared-cache) joining exactly one container on each side, which yields a single clean
#     cross-project edge rather than a pair-wise mesh.
#
#   * Two opendockwatch.depends_on labels demonstrate manual edges - relationships Docker's own
#     depends_on/network data can't show. demo-shop-api -> payments resolves to a same-project
#     service (api calls the payment gateway over HTTP at runtime; the *compose* depends_on only
#     runs the other way, payments waiting on api at startup, which isn't the same relationship).
#     demo-blog-api -> demo-shop-api resolves via the literal-container-name fallback instead,
#     since the two projects share no service names - the blog's "shop the look" widget reading
#     product data from the shop API, with no network link between demo-front and demo-back to
#     reveal it.
#
# Two ports are published so the container list and the graph's port badges have something real to
# show. They default high to stay out of the way - 8080 in particular is often already taken, by
# Dozzle among others - and either can be overridden:
#
#   SHOP_PORT=9090 BLOG_PORT=9091 scripts/demo-stack.sh up
#
# In --isolated mode they are published inside the private daemon, so they cannot collide at all.
set -e

DIND_NAME=odw-demo-dind
SHOP_PORT=${SHOP_PORT:-8088}
BLOG_PORT=${BLOG_PORT:-8089}
CONTAINERS="demo-shop-db demo-shop-cache demo-shop-frontend demo-shop-api demo-shop-worker demo-shop-payments demo-shop-flaky demo-shop-migrate demo-blog-web demo-blog-api demo-blog-worker"
NETWORKS="demo-front demo-back shared-cache"
VOLUMES="demo-db-data"

CMD=${1:-}
MODE=${2:-}
[ "$MODE" = "--isolated" ] && ISOLATED=1 || ISOLATED=

D="docker"
[ -n "$ISOLATED" ] && D="docker exec $DIND_NAME docker"

usage() {
  echo "usage: $0 {up|down} [--isolated]" >&2
  exit 2
}

start_dind() {
  if docker inspect "$DIND_NAME" >/dev/null 2>&1; then
    echo "$DIND_NAME already exists - run '$0 down --isolated' first" >&2
    exit 1
  fi
  echo "== starting an isolated Docker daemon =="
  docker run -d --privileged --name "$DIND_NAME" \
    -v "${DIND_NAME}-sock":/var/run \
    -e DOCKER_TLS_CERTDIR= \
    docker:27-dind >/dev/null
  # dind deliberately delays startup to print its insecure-TCP warning, so this is not instant.
  i=0
  while [ "$i" -lt 60 ]; do
    if docker exec "$DIND_NAME" docker info >/dev/null 2>&1; then break; fi
    i=$((i + 1))
    sleep 2
  done
  docker exec "$DIND_NAME" docker info >/dev/null 2>&1 || {
    echo "isolated daemon did not come up; see: docker logs $DIND_NAME" >&2
    exit 1
  }
  echo "  ready"
}

up() {
  # Fail before creating anything rather than halfway through, leaving a partial stack behind.
  if [ -z "$ISOLATED" ]; then
    for name in $CONTAINERS; do
      if docker inspect "$name" >/dev/null 2>&1; then
        echo "$name already exists - run '$0 down' first" >&2
        exit 1
      fi
    done
  fi

  [ -n "$ISOLATED" ] && start_dind

  echo "== pulling images =="
  for img in alpine:3.20 nginx:alpine redis:7-alpine postgres:17-alpine; do
    $D pull -q "$img" >/dev/null
    echo "  $img"
  done

  echo "== networks =="
  for net in $NETWORKS; do $D network create "$net" >/dev/null; done
  echo "  $NETWORKS"

  SHOP="--label com.docker.compose.project=demo-shop"
  BLOG="--label com.docker.compose.project=demo-blog"

  echo "== demo-shop =="

  $D run -d --name demo-shop-db --network demo-back $SHOP \
    --label com.docker.compose.service=db \
    -e POSTGRES_PASSWORD=demo -e POSTGRES_USER=shop -e POSTGRES_DB=shop \
    --health-cmd "pg_isready -U shop" --health-interval 10s --health-retries 3 \
    -v demo-db-data:/var/lib/postgresql/data \
    postgres:17-alpine >/dev/null
  echo "  db"

  $D run -d --name demo-shop-cache --network demo-back $SHOP \
    --label com.docker.compose.service=cache \
    --health-cmd "redis-cli ping" --health-interval 10s --health-retries 3 \
    redis:7-alpine >/dev/null
  echo "  cache"

  $D run -d --name demo-shop-frontend --network demo-front $SHOP \
    --label com.docker.compose.service=frontend \
    --label com.docker.compose.depends_on=api:service_started \
    -p "$SHOP_PORT":80 nginx:alpine >/dev/null
  echo "  frontend (:$SHOP_PORT)"

  # The busy one: real CPU and network work so its sparklines and the metrics modal's charts have
  # shape rather than a flat line, and logs across every level the viewer filters on.
  $D run -d --name demo-shop-api --network demo-back $SHOP \
    --label com.docker.compose.service=api \
    --label com.docker.compose.depends_on=db:service_healthy,cache:service_healthy \
    --label opendockwatch.depends_on=payments:http \
    -e NODE_ENV=production -e DATABASE_URL=postgres://shop@demo-shop-db:5432/shop \
    -e REDIS_URL=redis://demo-shop-cache:6379 -e LOG_LEVEL=info \
    --health-cmd "true" --health-interval 10s \
    alpine:3.20 sh -c '
      i=0
      while :; do
        i=$((i+1))
        ts=$(date "+%Y-%m-%dT%H:%M:%S")
        awk "BEGIN{for(j=0;j<400000;j++)x+=j*1.000001}" >/dev/null
        wget -q -O /dev/null http://demo-shop-cache:6379 2>/dev/null || true
        printf "%s [INFO] handled request id=%d path=/api/orders status=200 latency_ms=%d\n" "$ts" "$i" $((20 + i % 90))
        [ $((i % 7)) -eq 0 ] && printf "%s [WARN] cache miss for key=cart:%d, falling back to postgres\n" "$ts" "$i"
        [ $((i % 11)) -eq 0 ] && printf "%s [ERROR] failed to connect to redis: connection refused (attempt %d)\n" "$ts" "$i" >&2
        [ $((i % 19)) -eq 0 ] && printf "%s [DEBUG] connection pool size=8 idle=3 waiting=0\n" "$ts"
        sleep 1
      done' >/dev/null
  echo "  api"

  # Bursty rather than steady, so its sparkline has peaks instead of a flat band.
  $D run -d --name demo-shop-worker --network demo-back $SHOP \
    --label com.docker.compose.service=worker \
    --label com.docker.compose.depends_on=cache:service_healthy \
    -e QUEUE=orders -e CONCURRENCY=4 \
    alpine:3.20 sh -c '
      i=0
      while :; do
        i=$((i+1))
        ts=$(date "+%Y-%m-%dT%H:%M:%S")
        if [ $((i % 6)) -eq 0 ]; then
          awk "BEGIN{for(j=0;j<900000;j++)x+=j*1.000001}" >/dev/null
          dd if=/dev/zero of=/tmp/spool bs=64k count=24 2>/dev/null
          printf "%s [INFO] job batch complete queue=orders processed=%d duration_ms=%d\n" "$ts" $((i * 3)) $((300 + i % 400))
        else
          printf "%s [INFO] polling queue=orders depth=%d\n" "$ts" $((i % 5))
        fi
        sleep 2
      done' >/dev/null
  echo "  worker"

  # Fails its health check forever - gives the unhealthy dot, the red node border, and the
  # `unhealthy` alert rule something to fire on.
  $D run -d --name demo-shop-payments --network demo-back $SHOP \
    --label com.docker.compose.service=payments \
    --label com.docker.compose.depends_on=api:service_started \
    --health-cmd "exit 1" --health-interval 10s --health-retries 2 --health-start-period 5s \
    alpine:3.20 sh -c '
      while :; do
        printf "%s [WARN] payment gateway timeout, retrying in 5s\n" "$(date "+%Y-%m-%dT%H:%M:%S")"
        sleep 5
        printf "%s [ERROR] gateway unreachable: dial tcp 10.0.3.7:443: i/o timeout\n" "$(date "+%Y-%m-%dT%H:%M:%S")" >&2
        sleep 5
      done' >/dev/null
  echo "  payments (unhealthy by design)"

  # Crash loops, for the restart badge and the crash_loop alert. The cycle is deliberately slow:
  # at 20s it produced so many die/start events that nothing else was visible in the Activity view.
  $D run -d --name demo-shop-flaky --network demo-back $SHOP \
    --label com.docker.compose.service=flaky \
    --restart always \
    alpine:3.20 sh -c '
      printf "%s [INFO] starting image-resizer\n" "$(date "+%Y-%m-%dT%H:%M:%S")"
      sleep 150
      printf "%s [ERROR] out of memory processing upload, exiting\n" "$(date "+%Y-%m-%dT%H:%M:%S")" >&2
      exit 1' >/dev/null
  echo "  flaky (crash loop by design)"

  # Exits cleanly almost immediately, so there is a stopped container to show.
  $D run -d --name demo-shop-migrate --network demo-back $SHOP \
    --label com.docker.compose.service=migrate \
    alpine:3.20 sh -c '
      printf "%s [INFO] applying migration 0042_add_orders_index\n" "$(date "+%Y-%m-%dT%H:%M:%S")"
      sleep 2
      printf "%s [INFO] migration complete in 1.8s\n" "$(date "+%Y-%m-%dT%H:%M:%S")"' >/dev/null
  echo "  migrate (one-shot)"

  echo "== demo-blog =="

  $D run -d --name demo-blog-web --network demo-front $BLOG \
    --label com.docker.compose.service=web \
    --label com.docker.compose.depends_on=api:service_started \
    -p "$BLOG_PORT":80 nginx:alpine >/dev/null
  echo "  web (:$BLOG_PORT)"

  $D run -d --name demo-blog-api --network demo-front $BLOG \
    --label com.docker.compose.service=api \
    --label opendockwatch.depends_on=demo-shop-api:reads \
    -e NODE_ENV=production -e CACHE_URL=redis://demo-shop-cache:6379 \
    --health-cmd "true" --health-interval 10s \
    alpine:3.20 sh -c '
      i=0
      while :; do
        i=$((i+1))
        ts=$(date "+%Y-%m-%dT%H:%M:%S")
        awk "BEGIN{for(j=0;j<250000;j++)x+=j*1.000001}" >/dev/null
        if [ $((i % 3)) -eq 0 ]; then c=miss; else c=hit; fi
        printf "%s [INFO] rendered post id=%d template=article cache=%s\n" "$ts" "$i" "$c"
        [ $((i % 13)) -eq 0 ] && printf "%s [WARN] slow query: SELECT * FROM posts took %dms\n" "$ts" $((900 + i % 600))
        sleep 2
      done' >/dev/null
  echo "  api"

  $D run -d --name demo-blog-worker --network demo-front $BLOG \
    --label com.docker.compose.service=worker \
    --label com.docker.compose.depends_on=api:service_started \
    alpine:3.20 sh -c '
      i=0
      while :; do
        i=$((i+1))
        printf "%s [INFO] sitemap rebuild queued run=%d\n" "$(date "+%Y-%m-%dT%H:%M:%S")" "$i"
        sleep 4
      done' >/dev/null
  echo "  worker"

  # The single cross-project link. Only these two containers join it, so the graph draws one
  # network edge between the projects rather than an edge per pair.
  $D network connect shared-cache demo-blog-api
  $D network connect shared-cache demo-shop-cache
  echo "  shared-cache joins demo-blog-api <-> demo-shop-cache"

  # The frontend sits on both networks, so it also has a real reason to appear on demo-back.
  $D network connect demo-back demo-shop-frontend

  echo
  if [ -n "$ISOLATED" ]; then
    cat <<EOF
The stack is inside $DIND_NAME, not on this daemon. To point OpenDockWatch at it, run the app
with that daemon's socket mounted as its own - the app then treats it as an ordinary local host,
so the host-total overlay on the CPU/RAM tiles still works:

  docker run -d --name odw-demo -p 3100:3000 \\
    -v ${DIND_NAME}-sock:/var/run \\
    -v "\$PWD/data":/app/data -v "\$PWD/config":/app/config \\
    --env-file .env opendockwatch:local

Metrics history is written every 5s, so leave it running a while before taking screenshots that
show the host card's 30-minute chart.
EOF
  else
    echo "The stack is on this daemon. Start OpenDockWatch as usual and it will pick it up."
  fi
}

down() {
  if [ -n "$ISOLATED" ]; then
    docker rm -f "$DIND_NAME" >/dev/null 2>&1 || true
    docker volume rm "${DIND_NAME}-sock" >/dev/null 2>&1 || true
    echo "removed $DIND_NAME and its stack"
    return
  fi
  # shellcheck disable=SC2086
  $D rm -f $CONTAINERS >/dev/null 2>&1 || true
  for net in $NETWORKS; do $D network rm "$net" >/dev/null 2>&1 || true; done
  for vol in $VOLUMES; do $D volume rm "$vol" >/dev/null 2>&1 || true; done
  echo "removed the demo stack, its networks and its volumes"
}

case "$CMD" in
  up) up ;;
  down) down ;;
  *) usage ;;
esac
