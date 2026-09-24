import type { StoredSession } from './protocol';

type SessionWithLegacyMaterial = StoredSession & {
  kbName?: string;
  kbText?: string;
  jdName?: string;
  jdText?: string;
};

/** Normalize saved material slots, preserving older sessions during upgrade. */
export function normalizeSessionMaterial(
  input: StoredSession,
  fallbackName: string,
): StoredSession {
  const session = input as SessionWithLegacyMaterial;
  const { kbName, kbText, jdName, jdText, ...current } = session;

  return {
    ...current,
    resumeName: current.resumeName ?? (kbText ? kbName ?? fallbackName : undefined),
    resumeText: current.resumeText ?? kbText,
    secondResumeName: current.secondResumeName ?? jdName,
    secondResumeText: current.secondResumeText ?? jdText,
  };
}
