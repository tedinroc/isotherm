// scripts/size-caps.mjs: the relay/drip caps must spread the relayer's spendable MON over a horizon of N UTC days
// (default 7), not let one worst-case day take all of it (verifier round 2, issue 1).
import { describe, expect, it } from 'vitest';
import { DEFAULTS, parseArgs, sizeCaps } from '../../scripts/size-caps.mjs';

const GWEI = 1e-9; // MON per gas at 1 gwei

describe('size-caps: horizon', () => {
  it('defaults to a 7-day horizon', () => {
    expect(DEFAULTS.days).toBe(7);
    expect(sizeCaps({ balance: 4.6, gasPrice: 102 * GWEI }).inputs.days).toBe(7);
  });

  it('at the live 4.599 MON / 102 gwei: one worst-case day fits in spendable / 7, and 7 such days fit in spendable', () => {
    const s = sizeCaps({ balance: 4.599171502, gasPrice: 102 * GWEI });
    expect(s.spendable).toBeCloseTo(4.499171502, 9);
    expect(s.perDay).toBeCloseTo(4.499171502 / 7, 9);
    expect([s.dripCap, s.relayCap, s.dripPerIp, s.relayPerIp]).toEqual([2, 9, 1, 4]);
    expect(s.worstDay).toBeLessThanOrEqual(s.perDay);
    expect(s.worstHorizon).toBeLessThanOrEqual(s.spendable);
    expect(s.fitsDay && s.fitsHorizon).toBe(true);
    expect(s.vars).toEqual({
      RELAYER_MIN_MON: '0.1',
      DRIP_GAS_MON: '0.011',
      RELAY_COST_MON: '0.035',
      DRIP_DAILY_CAP: '2',
      DRIP_PER_IP_PER_DAY: '1',
      RELAY_DAILY_CAP: '9',
      RELAY_PER_IP_PER_DAY: '4',
      RELAY_PER_ADDRESS_PER_DAY: '4',
    });
  });

  it('without a horizon (the old sizing, days = 1) a single day could spend almost all of it', () => {
    const one = sizeCaps({ balance: 4.599171502, gasPrice: 102 * GWEI, days: 1 });
    expect(one.worstDay / one.spendable).toBeGreaterThan(0.95);
    const week = sizeCaps({ balance: 4.599171502, gasPrice: 102 * GWEI });
    expect(week.worstDay / week.spendable).toBeLessThanOrEqual(1 / 7);
    // days = 1 reproduces the round-1 sizing at 0.599 MON (2 drips + 5 relays)
    const r1 = sizeCaps({ balance: 0.599171502, gasPrice: 102 * GWEI, days: 1 });
    expect([r1.dripCap, r1.relayCap]).toEqual([2, 5]);
  });

  it('any balance, gas price and horizon: worst day <= spendable / days and the whole horizon <= spendable', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 2000; i++) {
      const balance = rnd() * 50;
      const gasPrice = (1 + rnd() * 400) * GWEI;
      const days = 1 + Math.floor(rnd() * 30);
      const dripShare = rnd();
      const s = sizeCaps({ balance, gasPrice, days, dripShare });
      expect(Number.isInteger(s.dripCap) && s.dripCap >= 0).toBe(true);
      expect(Number.isInteger(s.relayCap) && s.relayCap >= 0).toBe(true);
      expect(s.worstDay).toBeLessThanOrEqual(s.spendable / days + 1e-12);
      expect(s.worstDay * days).toBeLessThanOrEqual(s.spendable + 1e-12);
      // the relayer, spending the worst case every day, still holds the reserve after `days` days
      let bal = balance;
      for (let d = 0; d < days; d++) bal -= s.worstDay;
      expect(bal).toBeGreaterThanOrEqual(Math.min(balance, s.inputs.reserve) - 1e-9);
      // a longer horizon never allows more per day
      const longer = sizeCaps({ balance, gasPrice, days: days + 1, dripShare });
      expect(longer.worstDay).toBeLessThanOrEqual(s.perDay + 1e-12);
      expect(longer.dripCap).toBeLessThanOrEqual(s.dripCap);
    }
  });

  it('a relayer at or below the reserve gets no drips or relays', () => {
    const s = sizeCaps({ balance: 0.09, gasPrice: 102 * GWEI });
    expect([s.spendable, s.dripCap, s.relayCap, s.worstDay]).toEqual([0, 0, 0, 0]);
  });

  it('rejects a horizon that is not a whole number of days from 1 to 365', () => {
    for (const days of [0, -1, 1.5, Number.NaN, 366]) expect(() => sizeCaps({ balance: 4.6, gasPrice: 102 * GWEI, days })).toThrow(/days/);
    expect(() => sizeCaps({ balance: 4.6, gasPrice: 0 })).toThrow(/gasPrice/);
    expect(() => sizeCaps({ balance: 4.6, gasPrice: 102 * GWEI, dripShare: 1.5 })).toThrow(/dripShare/);
  });
});

describe('size-caps: arguments', () => {
  it('reads --days and the other flags', () => {
    expect(parseArgs(['--days', '14', '--reserve', '0.2'])).toEqual({ days: '14', reserve: '0.2' });
  });
  it('a typo or a missing value is an error, never a silent fallback to 7 days', () => {
    expect(() => parseArgs(['--day', '14'])).toThrow(/unknown argument --day/);
    expect(() => parseArgs(['--days'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--days', '--reserve', '0.1'])).toThrow(/needs a value/);
    expect(() => parseArgs(['14'])).toThrow(/unknown argument/);
  });
});
