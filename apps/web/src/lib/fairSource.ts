// The "Fair" figure on a strike is normally the Polymarket-implied probability. When the maker had to fall back to
// something else (packages/forecast/src/fair.ts), the strike shows a small label so the number is never read as
// Polymarket's. Pure: unit-tested in test/portfolio-sell-and-fair.test.ts.
import type { FairSource } from './api';

export type FairTag = 'observed' | 'model' | 'intraday' | 'unknown';

/**
 * null when the fair value is Polymarket-sourced (or there is no fair value to label); otherwise which label to show:
 *   certain           -> 'observed'  the observed max already reached the strike (fair = 1)
 *   fallback-v0       -> 'model'     our v0 climatology guard, because Polymarket was stale, off-grid or missing
 *   fallback-intraday -> 'intraday'  the same, from the intraday increment table
 *   anything else     -> 'unknown'   an older snapshot without fairSource, 'none' with a value, or a new source
 */
export function fairTag(fair: number | null | undefined, src: FairSource | string | null | undefined): FairTag | null {
  if (fair === null || fair === undefined || !Number.isFinite(fair)) return null;
  switch (src) {
    case 'polymarket':
      return null;
    case 'certain':
      return 'observed';
    case 'fallback-v0':
      return 'model';
    case 'fallback-intraday':
      return 'intraday';
    default:
      return 'unknown';
  }
}
