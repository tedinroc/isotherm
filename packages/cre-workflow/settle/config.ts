// Workflow configuration (config.*.json), validated with zod at load time inside the CRE runtime.
import { z } from 'zod'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

export const stationSchema = z.object({
  icao: z.string().regex(/^[A-Z0-9]{4}$/), // bytes4 on chain, e.g. RCSS = 0x52435353
  utcOffsetMin: z.number().int().min(-720).max(840), // fixed offset (RCSS +480, RJTT +540); must equal Resolver.stations()
  tzName: z.string().min(3), // IANA name for IEM's tz= parameter (these stations have no DST)
})

export const configSchema = z
  .object({
    chainSelectorName: z.string(), // "monad-testnet"
    chainId: z.string().regex(/^\d+$/), // bound into the EIP-712 domain of the attestation
    resolverAddress: address,
    vaultAddress: address, // CollateralVault: ladderCount() + duePendingLadders(start,count)
    // Cron triggers. All handlers run the same code. Keep any two fires >= 30 min apart and
    // attestationTtlSec < that spacing, so two attestations for one (station,date) are never valid at once.
    schedules: z.array(z.string().min(9)).min(1).max(10),
    gasLimit: z.string().regex(/^\d+$/).default('200000'), // ~150k used; Monad bills the LIMIT
    attestationTtlSec: z.number().int().min(60).max(1800).default(1500), // validUntil = trigger time + this
    settleDelaySec: z.number().int().min(60).default(7200), // first attempt at dayEnd + 2 h (02:00 local; IEM lags 1-2 h)
    voidAfterSec: z.number().int().min(3600).default(129600), // our VOID deadline: dayEnd + 36 h (healthy sources only)
    // Backstop: from dayEnd + 46 h we VOID even if a source is still failing (the outcome a stale void at 48 h would
    // give anyway, but delivered by the workflow with a sourcesHash, so no third party has to call voidIfStale).
    hardVoidAfterSec: z.number().int().min(3600).default(165600),
    staleWindowSec: z.number().int().default(172800), // Resolver.STALE_WINDOW (48 h); voidAfter must stay below it
    maxHttpCalls: z.number().int().min(2).max(15).default(15), // CRE PerWorkflow.HTTPAction.CallLimit
    maxEvmReads: z.number().int().min(3).max(15).default(15), // CRE PerWorkflow.ChainRead.CallLimit
    maxReportsPerRun: z.number().int().min(1).max(7).default(5),
    // Ogimet throttles back-to-back queries (seen live: a second query 13 s later failed) and every DON node hits it.
    maxFallbackCallsPerRun: z.number().int().min(0).max(5).default(1),
    ladderCursorStart: z.number().int().min(0).default(0), // never scan ladders below this index
    ladderScanWindow: z.number().int().min(1).max(512).default(64), // scan the newest N ladders
    ladderPageSize: z.number().int().min(1).max(128).default(32), // ladders per duePendingLadders() read
    readBlock: z.enum(['finalized', 'latest']).default('finalized'),
    // Replay/demo only: station-dates to settle even without a vault ladder (each costs one resultOf read).
    extraTargets: z
      .array(z.object({ icao: z.string().regex(/^[A-Z0-9]{4}$/), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
      .max(5)
      .default([]),
    stations: z.array(stationSchema).min(1).max(10),
  })
  .superRefine((c, ctx) => {
    if (c.voidAfterSec + c.attestationTtlSec >= c.staleWindowSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `voidAfterSec + attestationTtlSec (${c.voidAfterSec + c.attestationTtlSec}) must be < staleWindowSec (${c.staleWindowSec})`,
      })
    }
    if (c.hardVoidAfterSec < c.voidAfterSec || c.hardVoidAfterSec + c.attestationTtlSec >= c.staleWindowSec) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'need voidAfterSec <= hardVoidAfterSec and hardVoidAfterSec + attestationTtlSec < staleWindowSec' })
    }
    if (c.settleDelaySec >= c.voidAfterSec) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'settleDelaySec must be < voidAfterSec' })
    }
    const seen = new Set<string>()
    for (const s of c.stations) {
      if (seen.has(s.icao)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate station ${s.icao}` })
      seen.add(s.icao)
    }
  })

export type Config = z.infer<typeof configSchema>
export type ConfigInput = z.input<typeof configSchema>
export type StationCfg = z.infer<typeof stationSchema>
