import { describe, expect, it } from 'vitest';
import { shouldSynthesizeMouseClick } from '../shared/uiInteractionFallback';

describe('shouldSynthesizeMouseClick', () => {
  const event = {
    nativeActivationSeen: true,
    pointerDownObserved: false,
    isTrusted: true,
    button: 0,
  };

  it('recovers a primary click when Windows activation ate pointerdown', () => {
    expect(shouldSynthesizeMouseClick(event)).toBe(true);
  });

  it('does not synthesize a second click when pointerdown reached the renderer', () => {
    expect(shouldSynthesizeMouseClick({ ...event, pointerDownObserved: true })).toBe(false);
  });

  it('requires a trusted primary click and a native activation signal', () => {
    expect(shouldSynthesizeMouseClick({ ...event, nativeActivationSeen: false })).toBe(false);
    expect(shouldSynthesizeMouseClick({ ...event, isTrusted: false })).toBe(false);
    expect(shouldSynthesizeMouseClick({ ...event, button: 2 })).toBe(false);
  });
});
