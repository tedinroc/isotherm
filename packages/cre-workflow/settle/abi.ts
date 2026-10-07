// Minimal read surface of the v1 contracts the workflow calls. Kept small on purpose (it is bundled into the WASM);
// test/abi.test.ts checks every fragment against the exported ABIs in packages/abi/*.json.
export const RESOLVER_ABI = [
  {
    type: 'function',
    name: 'resultOf',
    stateMutability: 'view',
    inputs: [
      { name: 'station', type: 'bytes4' },
      { name: 'date', type: 'uint32' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct IIsothermResolver.Result',
        components: [
          { name: 'status', type: 'uint8', internalType: 'enum IIsothermResolver.Status' },
          { name: 'tmaxC', type: 'int16', internalType: 'int16' },
          { name: 'resolvedAt', type: 'uint64', internalType: 'uint64' },
          { name: 'finalAt', type: 'uint64', internalType: 'uint64' },
          { name: 'sourcesHash', type: 'bytes32', internalType: 'bytes32' },
        ],
      },
    ],
  },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool', internalType: 'bool' }] },
] as const

export const VAULT_ABI = [
  { type: 'function', name: 'ladderCount', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }] },
  {
    type: 'function',
    name: 'duePendingLadders',
    stateMutability: 'view',
    inputs: [
      { name: 'start', type: 'uint256', internalType: 'uint256' },
      { name: 'count', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [
      {
        name: 'due',
        type: 'tuple[]',
        internalType: 'struct StrikeFactory.LadderRef[]',
        components: [
          { name: 'station', type: 'bytes4', internalType: 'bytes4' },
          { name: 'date', type: 'uint32', internalType: 'uint32' },
        ],
      },
    ],
  },
] as const

/** Resolver.Status */
export const STATUS = { None: 0, Settled: 1, Void: 2 } as const
