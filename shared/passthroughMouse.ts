import type { PassthroughMouseEvent } from './protocol';

export function parsePassthroughMouseLine(line: string): PassthroughMouseEvent | null {
  const fields = line.trim().split('\t');
  const type = fields[0];
  if (!['move', 'down', 'up', 'wheel'].includes(type)) return null;
  if (fields.length !== (type === 'wheel' ? 4 : 3)) return null;
  if (fields.slice(1).some((field) => field.trim() === '')) return null;
  const numbers = fields.slice(1).map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  const [x, y, delta] = numbers;
  if (type === 'wheel' && delta === 0) return null;
  return type === 'wheel'
    ? { type, x, y, delta }
    : { type: type as 'move' | 'down' | 'up', x, y };
}

export function pointInWindow(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width &&
    point.y >= bounds.y && point.y < bounds.y + bounds.height;
}
