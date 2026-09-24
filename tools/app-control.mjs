import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandForStart } from './app-control-launch.mjs';

const repoRoot = resolve(process.cwd());
const repoId = createHash('sha1').update(repoRoot).digest('hex').slice(0, 12);
const pidFile = process.env.MC_APP_CONTROL_PID_FILE ?? join(tmpdir(), `meeting-copilot-${repoId}.json`);
const logFile = process.env.MC_APP_CONTROL_LOG_FILE ?? join(tmpdir(), `meeting-copilot-${repoId}.log`);

function readState() {
  if (!existsSync(pidFile)) return null;
  try {
    const state = JSON.parse(readFileSync(pidFile, 'utf8'));
    if (!state || typeof state.pid !== 'number' || state.cwd !== repoRoot) throw new Error('invalid state');
    return state;
  } catch {
    unlinkSync(pidFile);
    return null;
  }
}

function writeState(pid) {
  mkdirSync(join(pidFile, '..'), { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid, cwd: repoRoot, startedAt: new Date().toISOString() }, null, 2));
}

function removeState() {
  try {
    unlinkSync(pidFile);
  } catch {
    // The state may already be gone after a failed or repeated stop.
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function start() {
  const current = readState();
  if (current && isRunning(current.pid)) {
    console.log(`[app-control] already running (pid ${current.pid})`);
    return;
  }
  if (current) removeState();

  mkdirSync(join(logFile, '..'), { recursive: true });
  const logFd = openSync(logFile, 'a');
  const { command, args } = commandForStart({ repoRoot });
  let child;
  try {
    child = spawn(command, args, {
      cwd: repoRoot,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  writeState(child.pid);
  console.log(`[app-control] started (pid ${child.pid})`);
}

function stop() {
  const current = readState();
  if (!current) {
    console.log('[app-control] not running');
    return;
  }

  if (isRunning(current.pid)) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill.exe', ['/PID', String(current.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // The process may have exited during the stop request.
      }
    } else {
      try {
        process.kill(-current.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(current.pid, 'SIGTERM');
        } catch {
          // The process may have exited during the stop request.
        }
      }
    }
  }
  removeState();
  console.log(`[app-control] stopped (pid ${current.pid})`);
}

const action = process.argv[2];
if (action === 'start') start();
else if (action === 'stop') stop();
else {
  console.error('Usage: node tools/app-control.mjs <start|stop>');
  process.exitCode = 2;
}
