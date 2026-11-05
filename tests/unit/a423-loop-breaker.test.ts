import { describe, expect, it } from 'vitest';
import { detectOutputLoop, nextLoopCheckLength } from '@/lib/agents/loop-breaker';

describe('agent output loop breaker', () => {
  it('leaves normal prose alone', () => {
    const text = [
      'The job is running at 27% progress.',
      'I will wait for the runner to submit the artifact.',
      'No further polling is needed in this turn.',
    ].join('\n');
    expect(detectOutputLoop(text)).toBeNull();
  });

  it('detects a repeated streamed parameter block', () => {
    const block = [
      '<rfl:parameter name="until">',
      '["submitted", "verified", "paid", "settled", "completed"]',
      '</rfl:parameter>',
    ].join('\n');
    const result = detectOutputLoop(Array.from({ length: 7 }, () => block).join('\n'));
    expect(result?.kind).toBe('repeated-line');
    expect(result?.count).toBeGreaterThanOrEqual(6);
  });

  it('detects repeated parameter tags without newlines', () => {
    const text = Array.from({ length: 8 }, () => '<rfl:parameter name="until">["submitted"]</rfl:parameter>').join('');
    const result = detectOutputLoop(text);
    expect(result?.kind).toBe('repeated-parameter');
    expect(result?.sample).toBe('<rfl:parameter name="until">');
    expect(result?.count).toBeGreaterThanOrEqual(6);
  });

  it('uses small incremental checks while streaming', () => {
    expect(nextLoopCheckLength(1000)).toBe(1256);
  });
});
