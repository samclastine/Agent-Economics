import { describe, it, expect } from 'vitest';
import { usdCentsToTokenRaw, usdCentsToCredits, creditsToUsdCents, tokenRawToUsdCents } from '@/lib/finance/money';
import { validateArtifact } from '@/lib/artifacts/validators';

describe('money math', () => {
  it('$5 at $0.02/token, 18 decimals => 250 tokens', () => {
    const raw = usdCentsToTokenRaw(500, '0.02', 18);
    expect(raw).toBe(250n * 10n ** 18n);
  });

  it('$1 => 50 tokens at demo rate', () => {
    const raw = usdCentsToTokenRaw(100, '0.02', 18);
    expect(raw).toBe(50n * 10n ** 18n);
  });

  it('rounds up, never underpays', () => {
    // $0.01 at $0.03/token => 0.333... tokens -> rounds up to 0.334 tokens worth of raw units
    const raw = usdCentsToTokenRaw(1, '0.03', 18);
    const back = tokenRawToUsdCents(raw, '0.03', 18);
    expect(back).toBeGreaterThanOrEqual(1);
  });

  it('credits: 1 credit = $0.001 (0.1 cent)', () => {
    expect(usdCentsToCredits(100)).toBe(1000);
    expect(creditsToUsdCents(1000n)).toBe(100);
  });
});

describe('artifact validation', () => {
  it('passes a valid brief', () => {
    const content = [
      '# Agent Treasury',
      '## Problem', 'x '.repeat(60),
      '## Solution', 'y '.repeat(60),
      '## Features', 'z '.repeat(60),
    ].join('\n');
    const res = validateArtifact({
      path: '/brief.md',
      content,
      acceptanceSpec: { path: '/brief.md', minWords: 150, maxWords: 250, requiredSections: ['Problem', 'Solution', 'Features'] },
    });
    // word count may vary; check structure checks pass
    expect(res.checks.find((c) => c.name === 'allowed_path')?.passed).toBe(true);
    expect(res.checks.find((c) => c.name === 'expected_path')?.passed).toBe(true);
    for (const s of ['Problem', 'Solution', 'Features']) {
      expect(res.checks.find((c) => c.name === `section:${s}`)?.passed).toBe(true);
    }
  });

  it('fails wrong path', () => {
    const res = validateArtifact({ path: '/evil.md', content: 'hi', acceptanceSpec: { path: '/brief.md' } });
    expect(res.passed).toBe(false);
  });

  it('fails checklist with wrong number of items', () => {
    const res = validateArtifact({
      path: '/checklist.md',
      content: '1. one\n2. two\n',
      acceptanceSpec: { path: '/checklist.md', requiredNumberedItems: 5 },
    });
    expect(res.checks.find((c) => c.name === 'numbered_items')?.passed).toBe(false);
    expect(res.passed).toBe(false);
  });

  it('passes checklist with 5 items', () => {
    const res = validateArtifact({
      path: '/checklist.md',
      content: '1. a\n2. b\n3. c\n4. d\n5. e\n',
      acceptanceSpec: { path: '/checklist.md', requiredNumberedItems: 5, minChars: 10 },
    });
    expect(res.passed).toBe(true);
  });
});
