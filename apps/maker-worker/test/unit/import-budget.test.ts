// scripts/import-budget.mjs: the Mac's single MON meter per role is re-booked onto the Worker's split meters at cutover.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs operator script (no types)
import { prepareImport } from "../../scripts/import-budget.mjs";

const state = (spent: Record<string, number>, txs: Record<string, number>) => ({
  version: 1,
  deployment: { vault: "0xae36cf0a163bAfCde4D40a6Ab7b5E3C762ad7B39", resolver: "0x9c", zap: null, source: "/some/local/path/deployments/testnet.json", variant: "v1" },
  ladders: {},
  budget: { day: "2026-10-08", spent, txs, history: [] },
  events: [],
});
const line = (t: string, role: string, kind: string, mon: number) => JSON.stringify({ t, role, kind, mon, label: kind });
// 2026-10-08 Taipei = 2026-10-07T16:00Z .. 2026-10-08T16:00Z
const log = [
  line("2026-10-07T15:59:00.000Z", "maker", "quote", 0.5), // the day before (Taipei)
  line("2026-10-08T01:00:00.000Z", "maker", "quote", 0.0579),
  line("2026-10-08T02:00:00.000Z", "maker", "pull", 0.0281),
  line("2026-10-08T04:01:00.000Z", "operator", "roll", 0.1225),
  line("2026-10-08T04:02:00.000Z", "maker", "roll", 0.0321),
  line("2026-10-08T04:03:00.000Z", "marketCreator", "roll", 0.1497),
].join("\n");

describe("prepareImport (cutover: Mac state.json -> Worker live state)", () => {
  it("re-books today's roll spend onto <role>:roll and scrubs the local deployment path", () => {
    const { state: out, notes } = prepareImport(state({ maker: 0.1181, operator: 0.1225, marketCreator: 0.1497 }, { maker: 3, operator: 1, marketCreator: 1 }), log);
    expect(out.budget.spent).toEqual({ maker: 0.086, "operator:roll": 0.1225, "maker:roll": 0.0321, "marketCreator:roll": 0.1497 });
    expect(out.budget.txs).toEqual({ maker: 2, "operator:roll": 1, "maker:roll": 1, "marketCreator:roll": 1 });
    expect(out.deployment.source).not.toMatch(/\//);
    expect(notes.join(" ")).toMatch(/re-booked/);
  });
  it("keeps the meters unchanged without a tx log or when the log does not add up", () => {
    const s = state({ maker: 0.1181 }, { maker: 3 });
    expect(prepareImport(s, null).state.budget.spent).toEqual({ maker: 0.1181 });
    const bad = prepareImport(state({ maker: 0.9 }, { maker: 3 }), log);
    expect(bad.state.budget.spent).toEqual({ maker: 0.9 });
    expect(bad.notes.join(" ")).toMatch(/imported unchanged/);
  });
});
