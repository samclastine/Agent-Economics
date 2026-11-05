import Decimal from 'decimal.js';
import { parseUnits, formatUnits } from 'viem';

Decimal.set({ precision: 50 });

export const CREDIT_PRICE_USD_CENTS = 0.1; // 1 credit = $0.001

/** USD cents -> credits */
export function usdCentsToCredits(usdCents: number | bigint): number {
  return Number(usdCents) / CREDIT_PRICE_USD_CENTS;
}

/** credits -> USD cents (fractional; $0.001 per credit) */
export function creditsToUsdCents(credits: bigint): number {
  return Number(credits) * CREDIT_PRICE_USD_CENTS;
}

/**
 * Convert USD cents to a raw token amount using a USD price per token.
 * Rounds UP (charge the payer the rounded-up amount; never underpay).
 * Returns the raw base-unit integer as bigint.
 */
export function usdCentsToTokenRaw(
  usdCents: number | bigint,
  priceUsdPerToken: string,
  decimals: number,
): bigint {
  const usd = new Decimal(usdCents.toString()).div(100);
  const tokens = usd.div(new Decimal(priceUsdPerToken));
  return BigInt(parseUnits(tokens.toFixed(decimals, Decimal.ROUND_UP), decimals));
}

export function tokenRawToUsdCents(
  raw: bigint,
  priceUsdPerToken: string,
  decimals: number,
): number {
  const tokens = new Decimal(formatUnits(raw, decimals));
  const usd = tokens.mul(new Decimal(priceUsdPerToken));
  return usd.mul(100).toDecimalPlaces(0, Decimal.ROUND_UP).toNumber();
}

export function formatToken(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}
