import { describe, expect, it } from 'vitest';
import { displayTokenSymbol } from '@/lib/token-symbol';

describe('displayTokenSymbol', () => {
  it('shows the demo token as \$WIF', () => {
    expect(displayTokenSymbol('tWIF')).toBe('$WIF');
    expect(displayTokenSymbol('WIF')).toBe('$WIF');
    expect(displayTokenSymbol('$WIF')).toBe('$WIF');
    expect(displayTokenSymbol(null)).toBe('$WIF');
  });

  it('leaves other token symbols alone', () => {
    expect(displayTokenSymbol('USDC')).toBe('USDC');
  });
});
