import { keccak256, stringToHex } from 'viem';

/**
 * Canonical JSON used for the on-chain keccak commitment. The SDK's own
 * `hashAgreement` uses the same JSON canonicalisation but SHA-256; both
 * formats are recorded side by side and are intentionally not interchangeable.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value as number)) throw new TypeError('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  throw new TypeError('Use JSON values only');
}

/** keccak256(canonical JSON) — the contract's bytes32 specHash format. */
export function specHashFromSpec(spec: unknown): `0x${string}` {
  return keccak256(stringToHex(canonicalJson(spec)));
}

/** Stable application-assigned workflow id. UUID hyphens are allowed by the SDK id grammar. */
export function newWorkflowId(prefix = 'wf'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
