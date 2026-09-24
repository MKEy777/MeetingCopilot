import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { commandForStart } from '../tools/app-control-launch.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const controlScript = join(repoRoot, 'tools', 'app-control.mjs');

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitFor(condition: () => boolean, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error('timed out waiting for process state');
}

describe('npm app control', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'meeting-copilot-app-control-'));
  const pidFile = join(stateDir, 'state.json');
  const logFile = join(stateDir, 'app.log');
  const env = {
    ...process.env,
    MC_APP_CONTROL_RUNNER: process.execPath,
    MC_APP_CONTROL_RUNNER_ARGS_JSON: JSON.stringify(['-e', 'setInterval(() => {}, 60000)']),
    MC_APP_CONTROL_PID_FILE: pidFile,
    MC_APP_CONTROL_LOG_FILE: logFile,
  };

  afterEach(() => {
    if (!existsSync(pidFile)) return;
    const state = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number };
    if (isRunning(state.pid)) {
      try {
        process.kill(state.pid);
      } catch {
        // The process may have exited between the check and cleanup.
      }
    }
    rmSync(pidFile, { force: true });
  });

  it('starts in the background, avoids duplicates, and stops the managed process', () => {
    const start = () =>
      execFileSync(process.execPath, [controlScript, 'start'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
      });

    const firstOutput = start();
    const firstState = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number };
    expect(firstOutput).toContain('started');
    expect(isRunning(firstState.pid)).toBe(true);

    const secondOutput = start();
    const secondState = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number };
    expect(secondOutput).toContain('already running');
    expect(secondState.pid).toBe(firstState.pid);

    const stopOutput = execFileSync(process.execPath, [controlScript, 'stop'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    expect(stopOutput).toContain('stopped');
    waitFor(() => !isRunning(firstState.pid));
    expect(existsSync(pidFile)).toBe(false);
  });

  it('launches Electron directly on Windows instead of keeping a cmd/npm chain', () => {
    const launch = commandForStart({ platform: 'win32', repoRoot, env: {} });
    expect(launch.command.toLowerCase()).toContain('node_modules');
    expect(launch.command.toLowerCase()).toContain('electron');
    expect(launch.command.toLowerCase()).not.toMatch(/cmd(?:\.exe)?$/);
    expect(launch.args).toEqual([repoRoot]);
  });
});
