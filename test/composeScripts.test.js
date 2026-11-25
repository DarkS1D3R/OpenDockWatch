const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const composeScripts = require('../server/composeScripts');

const LOCAL = { id: 'local', dockerHost: null };
const REMOTE = { id: 'prod', dockerHost: 'ssh://deploy@prod.example.com' };
// Spawning a real shell script needs a POSIX shell; CI runs on Linux, a Windows checkout skips these.
const NO_SH = process.platform === 'win32';

function makeScriptsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odw-compose-scripts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeScript(dir, hostId, project, action, body, mode = 0o755) {
  const projectDir = path.join(dir, hostId, project);
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${action}.sh`);
  fs.writeFileSync(file, body, { mode });
  return file;
}

function runToEnd(opts) {
  return new Promise((resolve) => composeScripts.runScript({ ...opts, onDone: resolve }));
}

test('resolveScript finds <dir>/<hostId>/<project>/<action>.sh for the local host', async (t) => {
  const dir = makeScriptsDir(t);
  const file = writeScript(dir, 'local', 'shop', 'stop', '#!/bin/sh\n');
  assert.equal(await composeScripts.resolveScript(dir, LOCAL, 'shop', 'stop'), fs.realpathSync(file));
});

test('resolveScript returns null whenever no script applies, so the batch action runs instead', async (t) => {
  const dir = makeScriptsDir(t);
  writeScript(dir, 'local', 'shop', 'start', '#!/bin/sh\n');
  writeScript(dir, 'prod', 'shop', 'start', '#!/bin/sh\n');
  assert.equal(await composeScripts.resolveScript(null, LOCAL, 'shop', 'start'), null, 'feature off without a dir');
  assert.equal(await composeScripts.resolveScript(dir, LOCAL, 'shop', 'stop'), null, 'no stop.sh for this project');
  assert.equal(await composeScripts.resolveScript(dir, LOCAL, 'billing', 'start'), null, 'no folder for this project');
  assert.equal(await composeScripts.resolveScript(dir, LOCAL, 'shop', 'restart'), null, 'restart is not a script action yet');
  assert.equal(await composeScripts.resolveScript(dir, REMOTE, 'shop', 'start'), null, 'remote hosts are not supported yet');
});

test('resolveScript refuses a project name that could walk out of the scripts directory', async (t) => {
  const dir = makeScriptsDir(t);
  writeScript(dir, 'local', 'shop', 'start', '#!/bin/sh\n');
  for (const project of ['..', '../local/shop', 'Shop', '-rf', 'shop/..', '']) {
    assert.equal(await composeScripts.resolveScript(dir, LOCAL, project, 'start'), null, `project ${JSON.stringify(project)}`);
  }
});

test('resolveScript refuses a symlink that points outside the scripts directory', { skip: NO_SH }, async (t) => {
  const dir = makeScriptsDir(t);
  const outside = makeScriptsDir(t);
  const target = path.join(outside, 'evil.sh');
  fs.writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'local', 'shop'), { recursive: true });
  fs.symlinkSync(target, path.join(dir, 'local', 'shop', 'start.sh'));
  assert.equal(await composeScripts.resolveScript(dir, LOCAL, 'shop', 'start'), null);
});

test('resolveScript ignores a directory named like a script', async (t) => {
  const dir = makeScriptsDir(t);
  fs.mkdirSync(path.join(dir, 'local', 'shop', 'start.sh'), { recursive: true });
  assert.equal(await composeScripts.resolveScript(dir, LOCAL, 'shop', 'start'), null);
});

test('runScript passes the project context and no server secrets in the environment', { skip: NO_SH }, async (t) => {
  const dir = makeScriptsDir(t);
  const file = writeScript(
    dir,
    'local',
    'shop',
    'start',
    '#!/bin/sh\necho "$ODW_HOST_ID $ODW_COMPOSE_PROJECT $ODW_ACTION [$SESSION_SECRET] $(pwd)"\n'
  );
  process.env.SESSION_SECRET = 'must-not-leak';
  t.after(() => delete process.env.SESSION_SECRET);
  const run = await runToEnd({ host: LOCAL, project: 'shop', action: 'start', scriptPath: file });
  assert.equal(run.exitCode, 0);
  assert.ok(composeScripts.runSucceeded(run));
  assert.equal(run.output.trim(), `local shop start [] ${path.dirname(file)}`);
  assert.equal(composeScripts.isRunning('local', 'shop'), false);
});

test('runScript runs a script without the exec bit through sh', { skip: NO_SH }, async (t) => {
  const dir = makeScriptsDir(t);
  const file = writeScript(dir, 'local', 'shop', 'stop', 'echo ran\n', 0o644);
  const run = await runToEnd({ host: LOCAL, project: 'shop', action: 'stop', scriptPath: file });
  assert.equal(run.exitCode, 0);
  assert.equal(run.output.trim(), 'ran');
});

test('runScript reports a non-zero exit with its output as a failure', { skip: NO_SH }, async (t) => {
  const dir = makeScriptsDir(t);
  const file = writeScript(dir, 'local', 'shop', 'stop', '#!/bin/sh\necho "no such service: web" >&2\nexit 3\n');
  const run = await runToEnd({ host: LOCAL, project: 'shop', action: 'stop', scriptPath: file });
  assert.equal(run.exitCode, 3);
  assert.equal(composeScripts.runSucceeded(run), false);
  assert.match(run.output, /no such service: web/);
});

test('runScript kills the whole process group at the timeout', { skip: NO_SH }, async (t) => {
  const dir = makeScriptsDir(t);
  const marker = path.join(dir, 'child-survived');
  // The background sleep is the stand-in for a `docker compose` child: it must die with the script.
  const file = writeScript(dir, 'local', 'shop', 'start', `#!/bin/sh\n(sleep 2; touch "${marker}") &\nsleep 30\n`);
  process.env.COMPOSE_SCRIPT_TIMEOUT_MS = '300';
  t.after(() => delete process.env.COMPOSE_SCRIPT_TIMEOUT_MS);
  const startedAt = Date.now();
  const run = await runToEnd({ host: LOCAL, project: 'shop', action: 'start', scriptPath: file });
  assert.equal(run.timedOut, true);
  assert.equal(composeScripts.runSucceeded(run), false);
  assert.ok(Date.now() - startedAt < 5000, 'ended at the timeout, not when the script would have');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(fs.existsSync(marker), false, 'the script’s child process outlived the timeout kill');
});

test('runScript reports a spawn failure instead of throwing', async () => {
  const run = await runToEnd({
    host: LOCAL,
    project: 'gone',
    action: 'start',
    scriptPath: path.join(os.tmpdir(), 'odw-no-such-dir', 'start.sh'),
  });
  assert.equal(composeScripts.runSucceeded(run), false);
  assert.equal(run.running, false);
  assert.ok(run.error || run.exitCode !== 0);
});

test('appendCapped keeps the end of the output, not the start', () => {
  const big = 'a'.repeat(20 * 1024) + 'THE-END';
  const kept = composeScripts.appendCapped('', big);
  assert.equal(kept.length, 16 * 1024);
  assert.ok(kept.endsWith('THE-END'));
});
