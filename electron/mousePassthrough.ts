import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { join } from 'path';
import { getResourceRoot } from './resourcePaths';
import { parsePassthroughMouseLine } from '../shared/passthroughMouse';
import type { PassthroughMouseEvent } from '../shared/protocol';

/** Runs only while Windows mouse passthrough is enabled. The helper observes
 * physical input and always calls CallNextHookEx, leaving the original event
 * to reach the underlying application. No keyboard input is observed. */
export class MousePassthroughHost {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private abortStart: (() => void) | null = null;

  start(onMouse: (event: PassthroughMouseEvent) => void, onStopped: () => void): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();

    const script = join(getResourceRoot(), 'tools', 'mouse_passthrough.ps1');
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-1200);
    });

    this.starting = new Promise<void>((resolve, reject) => {
      let ready = false;
      let settled = false;
      this.abortStart = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        reject(new Error('mouse hook startup cancelled'));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stop();
        reject(new Error('mouse hook did not become ready'));
      }, 8000);
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        if (line === 'READY') {
          if (settled) return;
          ready = true;
          settled = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        if (!ready || this.child !== child) return;
        const event = parsePassthroughMouseLine(line);
        if (event) onMouse(event);
      });
      const failed = (reason: string) => {
        if (this.child !== child) return;
        this.child = null;
        clearTimeout(timer);
        lines.close();
        if (!settled) {
          settled = true;
          reject(new Error(`mouse hook stopped: ${stderr.trim() || reason}`));
        } else if (ready) {
          console.warn('[mouse-passthrough] helper stopped:', stderr.trim() || reason);
          onStopped();
        }
      };
      child.once('error', (error) => failed(error.message));
      child.once('exit', (code) => failed(`exit ${code}`));
    }).finally(() => {
      this.starting = null;
      this.abortStart = null;
    });
    return this.starting;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.abortStart?.();
    if (child && !child.killed) child.kill();
  }
}
