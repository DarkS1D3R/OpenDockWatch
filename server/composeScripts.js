// Admin-provided start/stop scripts for a compose project, found by convention under
// COMPOSE_SCRIPTS_DIR/<hostId>/<project>/<action>.sh. Local host only for now. See
// docs/architecture/server.md#compose-scripts.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT_ACTIONS = new Set(['start', 'stop']);
// Compose's own project-name rule; anything else can't be a real project and never reaches the filesystem.
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;
const OUTPUT_LIMIT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const KILL_GRACE_MS = 5_000;
// Inherited from the server's env so a script can find docker, git, etc. Nothing else is: .env holds secrets.
const PASSTHROUGH_ENV = ['PATH', 'HOME', 'LANG', 'TZ', 'DOCKER_HOST'];

const runs = new Map(); // "hostId\0project" -> run state

function scriptsDir() {
  const dir = process.env.COMPOSE_SCRIPTS_DIR;
  return dir ? path.resolve(dir) : null;
}

function scriptTimeoutMs() {
  const n = Number(process.env.COMPOSE_SCRIPT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// Absolute path of the script for this host/project/action, or null when none applies. realpath
// on both sides so neither `..` nor a symlink can point the lookup outside the scripts directory.
async function resolveScript(baseDir, host, project, action) {
  if (!baseDir || host.dockerHost || !SCRIPT_ACTIONS.has(action) || !PROJECT_RE.test(project)) return null;
  try {
    const realBase = await fs.promises.realpath(baseDir);
    const real = await fs.promises.realpath(path.join(baseDir, host.id, project, `${action}.sh`));
    if (!real.startsWith(realBase + path.sep)) return null;
    return (await fs.promises.stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

function scriptEnv(host, project, action) {
  const env = { ODW_HOST_ID: host.id, ODW_COMPOSE_PROJECT: project, ODW_ACTION: action };
  for (const key of PASSTHROUGH_ENV) if (process.env[key]) env[key] = process.env[key];
  return env;
}

// Keeps the last OUTPUT_LIMIT_BYTES of combined output - the end of a failing script is the useful part.
function appendCapped(current, chunk) {
  const next = current + chunk;
  return next.length > OUTPUT_LIMIT_BYTES ? next.slice(next.length - OUTPUT_LIMIT_BYTES) : next;
}

const runKey = (hostId, project) => `${hostId}\0${project}`;

function isRunning(hostId, project) {
  return !!runs.get(runKey(hostId, project))?.running;
}

function publicRun(run) {
  if (!run) return null;
  const { action, running, startedAt, finishedAt, exitCode, signal, timedOut, error, output } = run;
  return { action, running, startedAt, finishedAt, exitCode, signal, timedOut, error, output };
}

function getRun(hostId, project) {
  return publicRun(runs.get(runKey(hostId, project)));
}

function killTree(child, signal) {
  try {
    // Negative pid signals the whole process group, so `docker compose` children die with the script.
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already gone */
  }
}

// Starts the script and returns at once; onDone(run) fires exactly once when it exits, fails to
// spawn, or is killed at the timeout. The caller checks isRunning first - one run per project.
function runScript({ host, project, action, scriptPath, onDone = () => {} }) {
  const run = {
    action,
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    error: null,
    output: '',
  };
  runs.set(runKey(host.id, project), run);

  let executable = true;
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
  } catch {
    executable = false;
  }
  // No exec bit (common on a Windows-side bind mount): run it through sh rather than fail.
  const [cmd, args] = executable ? [scriptPath, []] : ['/bin/sh', [scriptPath]];

  let finished = false;
  let timeoutTimer = null;
  let killTimer = null;
  const finish = (fields) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    clearTimeout(killTimer);
    Object.assign(run, fields, { running: false, finishedAt: Date.now() });
    try {
      onDone(run);
    } catch {
      /* onDone owns its own errors; a throw here must not reach the child's event emitter */
    }
  };

  let child;
  try {
    child = spawn(cmd, args, {
      cwd: path.dirname(scriptPath),
      env: scriptEnv(host, project, action),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    finish({ error: err.message });
    return run;
  }

  timeoutTimer = setTimeout(() => {
    run.timedOut = true;
    killTree(child, 'SIGTERM');
    killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
  }, scriptTimeoutMs());

  const onOutput = (chunk) => {
    run.output = appendCapped(run.output, chunk.toString('utf8'));
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.on('error', (err) => finish({ error: err.message }));
  child.on('close', (code, signal) => finish({ exitCode: code, signal }));
  return run;
}

// A run counts as a success only on a clean exit 0 - a timeout or a signal is a failure even if the code says otherwise.
function runSucceeded(run) {
  return !run.error && !run.timedOut && run.exitCode === 0;
}

module.exports = {
  SCRIPT_ACTIONS,
  scriptsDir,
  resolveScript,
  runScript,
  runSucceeded,
  isRunning,
  getRun,
  publicRun,
  appendCapped,
  _runs: runs,
};
