/**
 * Human-facing token label.
 *
 * The testnet demo token's on-chain symbol is `tWIF`, and protocol terms keep
 * that raw value for validation. The product UI and agent copy call it `$WIF`.
 */
export function displayTokenSymbol(symbol?: string | null): string {
  if (!symbol) return '$WIF';
  const value = symbol.trim();
  if (/^\$?t?wif$/i.test(value)) return '$WIF';
  return value;
}
