import { describe, expect, it } from 'vitest';
import { normalizeSessionMaterial } from '../shared/sessionMigration';
import type { StoredSession } from '../shared/protocol';

const session = (overrides: Partial<StoredSession> = {}) =>
  ({ id: 's1', name: 'Session', createdAt: 1, turns: [], ...overrides }) as StoredSession;

describe('normalizeSessionMaterial', () => {
  it('moves legacy JD material into the second resume slot and strips legacy fields', () => {
    const old = { ...session(), jdName: '八股.md', jdText: 'Redis 面试题' };

    const normalized = normalizeSessionMaterial(old, '资料');

    expect(normalized.secondResumeName).toBe('八股.md');
    expect(normalized.secondResumeText).toBe('Redis 面试题');
    expect(normalized).not.toHaveProperty('jdName');
    expect(normalized).not.toHaveProperty('jdText');
  });

  it('keeps the new second resume when both new and legacy fields exist', () => {
    const old = {
      ...session({ secondResumeName: '新资料.md', secondResumeText: '新内容' }),
      jdName: '旧 JD.md',
      jdText: '旧内容',
    };

    const normalized = normalizeSessionMaterial(old, '资料');

    expect(normalized.secondResumeName).toBe('新资料.md');
    expect(normalized.secondResumeText).toBe('新内容');
    expect(normalized).not.toHaveProperty('jdName');
    expect(normalized).not.toHaveProperty('jdText');
  });

  it('moves the legacy single knowledge slot into the first resume slot', () => {
    const old = { ...session(), kbName: '旧资料.md', kbText: '旧简历资料' };

    const normalized = normalizeSessionMaterial(old, '资料');

    expect(normalized.resumeName).toBe('旧资料.md');
    expect(normalized.resumeText).toBe('旧简历资料');
    expect(normalized).not.toHaveProperty('kbName');
    expect(normalized).not.toHaveProperty('kbText');
  });
});
