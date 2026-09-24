import { join, resolve } from 'node:path';

/**
 * Build the detached GUI launch command used by `npm start`.
 *
 * Starting Electron directly avoids keeping a cmd.exe/npm process attached to
 * the terminal that ran the command. The runner override is retained for the
 * lifecycle test and for local diagnostics.
 */
export function commandForStart({ platform = process.platform, env = process.env, repoRoot = process.cwd() } = {}) {
  const overrideCommand = env.MC_APP_CONTROL_RUNNER;
  const overrideArgs = env.MC_APP_CONTROL_RUNNER_ARGS_JSON;
  if (overrideCommand) {
    return { command: overrideCommand, args: overrideArgs ? JSON.parse(overrideArgs) : [] };
  }

  const electronExecutable = platform === 'win32'
    ? 'electron.exe'
    : platform === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';
  const command = env.MC_ELECTRON_PATH ?? resolve(repoRoot, 'node_modules', 'electron', 'dist', electronExecutable);
  return { command, args: [repoRoot] };
}
