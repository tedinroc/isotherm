// Types for scripts/size-caps.mjs (imported by test/unit/size-caps.test.ts).
export interface SizeCapsDefaults {
  readonly reserve: number;
  readonly dripMon: number;
  readonly dripShare: number;
  readonly days: number;
  readonly dripGasUnits: number;
  readonly relayGasUnits: number;
}

export interface SizeCapsInput {
  /** relayer balance, MON */
  balance: number;
  /** MON per gas unit (eth_gasPrice / 1e18) */
  gasPrice: number;
  reserve?: number;
  dripMon?: number;
  dripShare?: number;
  /** horizon in whole UTC days (1–365), default 7 */
  days?: number;
  dripGasUnits?: number;
  relayGasUnits?: number;
}

export interface SizeCapsResult {
  inputs: SizeCapsDefaults & { balance: number; gasPrice: number };
  spendable: number;
  perDay: number;
  dripGas: number;
  dripCost: number;
  relayCost: number;
  dripCap: number;
  relayCap: number;
  dripPerIp: number;
  relayPerIp: number;
  worstDay: number;
  worstHorizon: number;
  fitsDay: boolean;
  fitsHorizon: boolean;
  vars: Record<
    | 'RELAYER_MIN_MON'
    | 'DRIP_GAS_MON'
    | 'RELAY_COST_MON'
    | 'DRIP_DAILY_CAP'
    | 'DRIP_PER_IP_PER_DAY'
    | 'RELAY_DAILY_CAP'
    | 'RELAY_PER_IP_PER_DAY'
    | 'RELAY_PER_ADDRESS_PER_DAY',
    string
  >;
}

export const DEFAULTS: SizeCapsDefaults;
export function parseArgs(argv: string[]): Record<string, string>;
export function sizeCaps(input: SizeCapsInput): SizeCapsResult;
