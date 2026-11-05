export const ERC20_ABI = [
  {
    name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'decimals', type: 'function', stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'symbol', type: 'function', stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'Transfer', type: 'event',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const ESCROW_ABI = [
  {
    name: 'createAndFundJob', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'bytes32' },
      { name: 'worker', type: 'address' },
      { name: 'verifier', type: 'address' },
      { name: 'tokenAmount', type: 'uint256' },
      { name: 'deadline', type: 'uint64' },
      { name: 'specHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'submitJob', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'bytes32' },
      { name: 'resultHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'release', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'refundExpired', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'getJob', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'bytes32' }],
    outputs: [
      { name: 'payer', type: 'address' },
      { name: 'worker', type: 'address' },
      { name: 'verifier', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint64' },
      { name: 'status', type: 'uint8' },
      { name: 'resultHash', type: 'bytes32' },
    ],
  },
  {
    name: 'JobFunded', type: 'event',
    inputs: [
      { name: 'jobId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'worker', type: 'address', indexed: true },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint64' },
    ],
  },
  {
    name: 'JobPaid', type: 'event',
    inputs: [
      { name: 'jobId', type: 'bytes32', indexed: true },
      { name: 'worker', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256' },
    ],
  },
  {
    name: 'JobRefunded', type: 'event',
    inputs: [
      { name: 'jobId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256' },
    ],
  },
] as const;

export const CREDIT_SHOP_ABI = [
  {
    name: 'buyCredits', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'orderId', type: 'bytes32' },
      { name: 'agentIdHash', type: 'bytes32' },
      { name: 'credits', type: 'uint256' },
      { name: 'tokenAmount', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'expiry', type: 'uint64' },
      { name: 'nonce', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'CreditsPurchased', type: 'event',
    inputs: [
      { name: 'orderId', type: 'bytes32', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'agentIdHash', type: 'bytes32' },
      { name: 'token', type: 'address' },
      { name: 'tokenAmount', type: 'uint256' },
      { name: 'credits', type: 'uint256' },
    ],
  },
  {
    name: 'usedNonces', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'buyer', type: 'address' }, { name: 'nonce', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;
