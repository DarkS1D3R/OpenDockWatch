const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// server/prometheus requires server/db, which opens a database the moment it's required - so this
// has to be set before the requires below, or these run against the real data/opendockwatch.db a
// container may hold open in WAL mode. Same reason as test/eventWatcher.test.js.
const TEST_DB_PATH = path.join(os.tmpdir(), `opendockwatch-prometheus-test-${process.pid}.db`);
process.env.OPENDOCKWATCH_DB_PATH = TEST_DB_PATH;

const prometheus = require('../server/prometheus');
const metricsCollector = require('../server/metricsCollector');
const db = require('../server/db');

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(TEST_DB_PATH + suffix, { force: true });
  }
});

// render() reads the collector's live snapshot map and two db counters, all through their module
// objects - so the whole thing is drivable from here without a daemon, a poll, or a seeded table.
function withSnapshots(t, snapshots, { restarts = new Map(), openAlerts = 0 } = {}) {
  t.mock.method(metricsCollector, 'getAllSnapshots', () => new Map(Object.entries(snapshots)));
  t.mock.method(db, 'getRestartCountsByContainer', () => restarts);
  t.mock.method(db, 'countOpenAlerts', () => openAlerts);
}

const container = (over = {}) => ({ id: 'aaaaaaaaaaaa', name: 'web', composeProject: 'shop', ...over });
const snapshot = (over = {}) => ({ containers: [container()], stats: {}, hostInfo: { containersRunning: 1 }, ...over });

const FAMILIES = [
  'opendockwatch_container_cpu_percent',
  'opendockwatch_container_mem_used_bytes',
  'opendockwatch_container_restarts_1h',
  'opendockwatch_host_containers_running',
  'opendockwatch_alerts_open',
];

// Nobody reads this endpoint by eye - a scraper does - so a malformed line doesn't look broken,
// it just quietly stops a dashboard updating. That is the whole reason these assertions are worth
// having: every failure mode here is silent in production.
test('prometheus exposition format', async (t) => {
  await t.test('every metric family carries HELP and TYPE, and they precede its samples', (t2) => {
    withSnapshots(t2, { local: snapshot() });
    const lines = prometheus.render().split('\n');
    for (const family of FAMILIES) {
      const help = lines.findIndex((l) => l === `# HELP ${family} ` || l.startsWith(`# HELP ${family} `));
      const type = lines.indexOf(`# TYPE ${family} gauge`);
      assert.ok(help !== -1, `no HELP line for ${family}`);
      assert.ok(type !== -1, `no TYPE line for ${family}`);
      assert.ok(help < type, `${family}'s HELP must come before its TYPE`);
      const firstSample = lines.findIndex((l) => l.startsWith(`${family}{`));
      assert.ok(firstSample > type, `${family} emitted a sample before its TYPE line`);
    }
  });

  // A scrape body that doesn't end in a newline is malformed. Trivially easy to break by editing
  // the join() at the bottom of render(), and invisible until a parser complains.
  await t.test('the body ends with a newline', (t2) => {
    withSnapshots(t2, { local: snapshot() });
    assert.ok(prometheus.render().endsWith('\n'));
  });

  // Zero configured hosts is a real state (a fresh install, or every host removed through
  // Settings) and must still produce a valid, parseable body rather than an empty one.
  await t.test('no hosts still renders a valid body with every family declared', (t2) => {
    withSnapshots(t2, {});
    const out = prometheus.render();
    for (const family of FAMILIES) {
      assert.match(out, new RegExp(`^# TYPE ${family} gauge$`, 'm'), `${family} vanished when there were no hosts`);
      assert.ok(!out.includes(`${family}{`), `${family} emitted a sample with no hosts to emit one for`);
    }
    assert.ok(out.endsWith('\n'));
  });

  // The format requires all samples of a family to be contiguous, which is exactly why render()
  // accumulates five separate arrays and concatenates them rather than emitting per host. Two
  // hosts is the smallest case that would catch someone "simplifying" that into one loop.
  await t.test('samples of one family stay contiguous across hosts', (t2) => {
    withSnapshots(t2, { local: snapshot(), remote: snapshot({ containers: [container({ id: 'bbbbbbbbbbbb', name: 'db' })] }) });
    const lines = prometheus.render().split('\n');
    for (const family of FAMILIES) {
      const at = lines.reduce((acc, l, i) => (l.startsWith(`${family}{`) ? [...acc, i] : acc), []);
      assert.equal(at.length, 2, `expected one ${family} sample per host`);
      assert.equal(at[1], at[0] + 1, `${family}'s two samples are not adjacent - the families are interleaved`);
    }
  });
});

// esc() is the only thing between a container name and a corrupt scrape. Container names are
// user-controlled (whoever runs `docker run --name`), so these are not hypothetical inputs.
test('prometheus label escaping', async (t) => {
  const labelsFor = (name) => {
    const out = prometheus.render();
    const line = out.split('\n').find((l) => l.startsWith('opendockwatch_container_cpu_percent{'));
    assert.ok(line, `no cpu sample rendered for ${JSON.stringify(name)}`);
    return line;
  };

  await t.test('a double quote in a container name is escaped, not left to close the label early', (t2) => {
    withSnapshots(t2, { local: snapshot({ containers: [container({ name: 'we"b' })] }) });
    assert.match(labelsFor('we"b'), /container="we\\"b"/);
  });

  await t.test('a backslash is escaped', (t2) => {
    withSnapshots(t2, { local: snapshot({ containers: [container({ name: 'we\\b' })] }) });
    assert.match(labelsFor('we\\b'), /container="we\\\\b"/);
  });

  // The one that corrupts the whole scrape rather than one label: a raw newline splits the sample
  // into two lines, and the parser reads the tail as a second, malformed metric.
  await t.test('a newline becomes a literal \\n and never a second line', (t2) => {
    withSnapshots(t2, { local: snapshot({ containers: [container({ name: 'web\nfake_metric 99' })] }) });
    const out = prometheus.render();
    assert.match(out, /container="web\\nfake_metric 99"/);
    assert.ok(!out.split('\n').some((l) => l.startsWith('fake_metric')), 'a newline in a container name broke out into its own line');
  });

  // Host ids come from hosts.json and go through the same escape - worth its own case because it
  // is a different call site, and the one that appears on every family including the host-level two.
  await t.test('the host label is escaped on every family, not just the container ones', (t2) => {
    withSnapshots(t2, { 'ho"st': snapshot() });
    const out = prometheus.render();
    for (const family of FAMILIES) {
      const line = out.split('\n').find((l) => l.startsWith(`${family}{`));
      assert.match(line, /host="ho\\"st"/, `${family} did not escape its host label`);
    }
  });

  await t.test('all three escapes compose in one value', (t2) => {
    withSnapshots(t2, { local: snapshot({ containers: [container({ name: 'a"b\\c\nd' })] }) });
    assert.match(labelsFor('a"b\\c\nd'), /container="a\\"b\\\\c\\nd"/);
  });
});

test('prometheus sample values', async (t) => {
  const valueOf = (out, family) =>
    Number(
      out
        .split('\n')
        .find((l) => l.startsWith(`${family}{`))
        .split('} ')[1]
    );

  await t.test('cpu and memory come off the stats row in their docker-string form', (t2) => {
    withSnapshots(t2, {
      local: snapshot({ stats: { aaaaaaaaaaaa: { cpuPerc: '1.47%', memUsage: '512MiB / 2GiB' } } }),
    });
    const out = prometheus.render();
    assert.equal(valueOf(out, 'opendockwatch_container_cpu_percent'), 1.47);
    assert.equal(valueOf(out, 'opendockwatch_container_mem_used_bytes'), 512 * 1024 ** 2);
  });

  // A container in `docker ps` with no row in the stats stream yet is routine (just created, or
  // the stream restarted). It has to render 0, not NaN - a NaN would make the whole line unparseable.
  await t.test('a container with no stats row renders 0, never NaN', (t2) => {
    withSnapshots(t2, { local: snapshot({ stats: {} }) });
    const out = prometheus.render();
    assert.equal(valueOf(out, 'opendockwatch_container_cpu_percent'), 0);
    assert.equal(valueOf(out, 'opendockwatch_container_mem_used_bytes'), 0);
    assert.ok(!out.includes('NaN'));
  });

  // Memory is an integer counter in the exposition, so the bytes have to be rounded rather than
  // carrying a float tail from parseByteString's multiplication. 1.1MiB, not a rounder figure:
  // 1.5MiB is already whole, so it passes with or without the Math.round and proves nothing -
  // confirmed by mutation, which is the only way that kind of dud assertion shows itself.
  await t.test('memory is rounded to whole bytes', (t2) => {
    withSnapshots(t2, { local: snapshot({ stats: { aaaaaaaaaaaa: { memUsage: '1.1MiB / 2GiB' } } }) });
    const value = valueOf(prometheus.render(), 'opendockwatch_container_mem_used_bytes');
    assert.ok(Number.isInteger(value), `expected whole bytes, got ${value}`);
    assert.equal(value, Math.round(1.1 * 1024 ** 2));
  });

  await t.test('restart counts come from the batched lookup, and default to 0', (t2) => {
    withSnapshots(
      t2,
      { local: snapshot({ containers: [container(), container({ id: 'bbbbbbbbbbbb', name: 'db' })] }) },
      { restarts: new Map([['aaaaaaaaaaaa', 3]]) }
    );
    const lines = prometheus
      .render()
      .split('\n')
      .filter((l) => l.startsWith('opendockwatch_container_restarts_1h{'));
    assert.match(lines[0], /container="web".*} 3$/);
    assert.match(lines[1], /container="db".*} 0$/, 'a container with no restarts must report 0, not be omitted');
  });

  await t.test('open alerts come from the per-host count', (t2) => {
    withSnapshots(t2, { local: snapshot() }, { openAlerts: 7 });
    assert.equal(valueOf(prometheus.render(), 'opendockwatch_alerts_open'), 7);
  });

  // A host that has never completed a poll, or one that just went unreachable, has no hostInfo -
  // reporting 0 running containers is the honest answer and must not throw on the way there.
  await t.test('a host with no hostInfo reports 0 running containers', (t2) => {
    withSnapshots(t2, { local: snapshot({ hostInfo: null }) });
    assert.equal(valueOf(prometheus.render(), 'opendockwatch_host_containers_running'), 0);
  });

  // markUnreachable empties a snapshot's containers, so this is the shape a down host actually
  // takes: the two host-level families still report, the per-container ones simply have nothing.
  await t.test('a host with no containers still reports its host-level families', (t2) => {
    withSnapshots(t2, { local: snapshot({ containers: [], hostInfo: { containersRunning: 0 } }) }, { openAlerts: 2 });
    const out = prometheus.render();
    assert.ok(!out.includes('opendockwatch_container_cpu_percent{'));
    assert.equal(valueOf(out, 'opendockwatch_host_containers_running'), 0);
    assert.equal(valueOf(out, 'opendockwatch_alerts_open'), 2);
  });

  await t.test('an absent containers array is treated as empty rather than throwing', (t2) => {
    withSnapshots(t2, { local: snapshot({ containers: undefined }) });
    assert.doesNotThrow(() => prometheus.render());
  });

  // An ungrouped container (no compose project) still gets the label, empty - dropping it instead
  // would give that container a different label set from its neighbours, which Prometheus treats
  // as a different time series.
  await t.test('a container with no compose project keeps the label with an empty value', (t2) => {
    withSnapshots(t2, { local: snapshot({ containers: [container({ composeProject: null })] }) });
    assert.match(prometheus.render(), /compose_project=""/);
  });
});
