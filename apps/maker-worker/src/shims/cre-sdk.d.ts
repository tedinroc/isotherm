// Type-only shim: packages/cre-workflow/settle/sources.ts imports `type HTTPSendRequester` from the CRE SDK for its
// DON fetcher; the Worker uses only the pure parts of that file (observe, toDayStats, sourceUrl), so the type import
// is erased at build time and this shim keeps the typecheck independent of the CRE package's node_modules.
export interface HTTPSendRequester {
  sendRequest(req: { url: string; method: string }): { result(): { statusCode: number; body: Uint8Array } };
}
