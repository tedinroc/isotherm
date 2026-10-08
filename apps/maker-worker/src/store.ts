// Persistent key/value store for the maker Durable Object, plus a bounded log and an HTTP cache.
// SqlStore runs on the SQLite-backed Durable Object storage (synchronous `ctx.storage.sql.exec`), so `put` returns
// only after the row is written and the runtime's output gate holds every outgoing request (RPC, broadcast) until
// it is durable: a plan or an in-flight tx hash is always on disk before the tx that depends on it leaves.
// MemStore is the same contract in memory, for the unit tests.

export interface Store {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): void;
  list<T>(prefix: string): [string, T][];
  /** Append to a bounded log (oldest rows dropped beyond `keep`). */
  append(log: string, row: unknown, keep: number): void;
  tail<T>(log: string, limit: number): T[];
  cacheGet(url: string): { at: number; body: string } | undefined;
  cachePut(url: string, body: string, at: number): void;
}

/** Cached bodies above this are not stored (a SQLite-backed DO row holds at most 2 MB). */
export const MAX_CACHE_BODY = 1_800_000;

export class MemStore implements Store {
  kv = new Map<string, string>();
  logs = new Map<string, string[]>();
  cache = new Map<string, { at: number; body: string }>();
  get<T>(key: string): T | undefined {
    const v = this.kv.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  put(key: string, value: unknown) {
    this.kv.set(key, stringify(value));
  }
  delete(key: string) {
    this.kv.delete(key);
  }
  list<T>(prefix: string): [string, T][] {
    return [...this.kv.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, JSON.parse(v) as T]);
  }
  append(log: string, row: unknown, keep: number) {
    const a = this.logs.get(log) ?? [];
    a.push(stringify(row));
    this.logs.set(log, a.slice(-keep));
  }
  tail<T>(log: string, limit: number): T[] {
    return (this.logs.get(log) ?? []).slice(-limit).map((x) => JSON.parse(x) as T);
  }
  cacheGet(url: string) {
    return this.cache.get(url);
  }
  cachePut(url: string, body: string, at: number) {
    if (body.length <= MAX_CACHE_BODY) this.cache.set(url, { at, body });
  }
}

/** JSON with bigints as decimal strings (viem returns bigints for gas, blocks and balances). */
export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

type Sql = DurableObjectStorage["sql"];

export class SqlStore implements Store {
  constructor(private sql: Sql) {
    sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, v TEXT NOT NULL, at INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS log_name ON log (name, id)");
    sql.exec("CREATE TABLE IF NOT EXISTS http_cache (url TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)");
  }
  get<T>(key: string): T | undefined {
    const rows = this.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", key).toArray();
    return rows.length ? (JSON.parse(rows[0].v) as T) : undefined;
  }
  put(key: string, value: unknown) {
    this.sql.exec("INSERT INTO kv (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at", key, stringify(value), Date.now());
  }
  delete(key: string) {
    this.sql.exec("DELETE FROM kv WHERE k = ?", key);
  }
  list<T>(prefix: string): [string, T][] {
    return this.sql
      .exec<{ k: string; v: string }>("SELECT k, v FROM kv WHERE k >= ? AND k < ? ORDER BY k", prefix, prefix + "￿")
      .toArray()
      .map((r) => [r.k, JSON.parse(r.v) as T]);
  }
  append(log: string, row: unknown, keep: number) {
    this.sql.exec("INSERT INTO log (name, v, at) VALUES (?, ?, ?)", log, stringify(row), Date.now());
    this.sql.exec("DELETE FROM log WHERE name = ? AND id <= (SELECT id FROM log WHERE name = ? ORDER BY id DESC LIMIT 1 OFFSET ?)", log, log, keep);
  }
  tail<T>(log: string, limit: number): T[] {
    return this.sql
      .exec<{ v: string }>("SELECT v FROM log WHERE name = ? ORDER BY id DESC LIMIT ?", log, limit)
      .toArray()
      .reverse()
      .map((r) => JSON.parse(r.v) as T);
  }
  cacheGet(url: string) {
    const rows = this.sql.exec<{ body: string; at: number }>("SELECT body, at FROM http_cache WHERE url = ?", url).toArray();
    return rows.length ? { at: Number(rows[0].at), body: rows[0].body } : undefined;
  }
  cachePut(url: string, body: string, at: number) {
    if (body.length > MAX_CACHE_BODY) return;
    this.sql.exec("INSERT INTO http_cache (url, body, at) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET body = excluded.body, at = excluded.at", url, body, at);
  }
}
