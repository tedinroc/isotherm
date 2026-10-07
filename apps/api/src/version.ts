// What /api/health and /api report as `version`: the app version and build id baked in at build time
// (scripts/build-info.mjs -> src/generated/build.json), plus the Cloudflare Worker version id and its upload
// (= deploy) time from the version_metadata binding. Together they say exactly which build is serving.
import build from './generated/build.json';

export interface VersionInfo {
  /** package.json version */
  app: string;
  /** `<git short commit>[-dirty].<sha256 of the deployed inputs, 12 hex>` */
  build: string;
  commit: string | null;
  dirty: boolean | null;
  /** when the bundle inputs were prepared (npm run prepare-data, part of npm run deploy) */
  builtAt: string;
  /** Cloudflare Worker version id (null outside Cloudflare) */
  workerVersionId: string | null;
  /** when Cloudflare received this Worker version, i.e. the deploy time (null under wrangler dev / tests) */
  deployedAt: string | null;
}

/** src/generated/build.json as written by scripts/build-info.mjs (read defensively: it is a build artefact). */
export interface BuildJson {
  app?: unknown;
  build?: unknown;
  commit?: unknown;
  dirty?: unknown;
  builtAt?: unknown;
}

export interface VersionMetadataLike {
  id?: unknown;
  timestamp?: unknown;
}

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
};

export function versionInfo(meta?: VersionMetadataLike | null, b: BuildJson = build as BuildJson): VersionInfo {
  return {
    app: typeof b.app === 'string' ? b.app : 'unknown',
    build: typeof b.build === 'string' ? b.build : 'unknown',
    commit: typeof b.commit === 'string' ? b.commit : null,
    dirty: typeof b.dirty === 'boolean' ? b.dirty : null,
    builtAt: typeof b.builtAt === 'string' ? b.builtAt : 'unknown',
    workerVersionId: meta && typeof meta.id === 'string' && /^[0-9a-f-]{8,64}$/i.test(meta.id) ? meta.id : null,
    deployedAt: meta ? iso(meta.timestamp) : null,
  };
}
