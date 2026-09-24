import { describe, expect, it } from 'vitest';
import { parsePassthroughMouseLine, pointInWindow } from '../shared/passthroughMouse';

describe('passthrough mouse input', () => {
  it('accepts a global click and wheel event with their screen coordinates', () => {
    expect(parsePassthroughMouseLine('down\t120\t240')).toEqual({ type: 'down', x: 120, y: 240 });
    expect(parsePassthroughMouseLine('wheel\t120\t240\t-120')).toEqual({
      type: 'wheel', x: 120, y: 240, delta: -120,
    });
  });

  it('rejects malformed helper output instead of sending it to the renderer', () => {
    expect(parsePassthroughMouseLine('READY')).toBeNull();
    expect(parsePassthroughMouseLine('down\tNaN\t240')).toBeNull();
    expect(parsePassthroughMouseLine('down\t\t240')).toBeNull();
    expect(parsePassthroughMouseLine('wheel\t120\t240\t0')).toBeNull();
  });

  it('forwards events only inside the visible overlay bounds', () => {
    const bounds = { x: 100, y: 200, width: 300, height: 180 };
    expect(pointInWindow({ x: 100, y: 200 }, bounds)).toBe(true);
    expect(pointInWindow({ x: 399, y: 379 }, bounds)).toBe(true);
    expect(pointInWindow({ x: 400, y: 240 }, bounds)).toBe(false);
    expect(pointInWindow({ x: 120, y: 199 }, bounds)).toBe(false);
  });
});
