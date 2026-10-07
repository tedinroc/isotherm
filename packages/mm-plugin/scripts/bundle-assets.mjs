#!/usr/bin/env node
// Build step: copy the repo's single source of truth into the package so the published tarball is self-contained.
//   ../../deployments/testnet.json -> assets/deployments.testnet.json   (if present)
//   ../abi/*.json                  -> assets/abi/                        (if present)
// assets/deployments.feasibility.json + assets/abi-feasibility/ are checked in and always shipped as the fallback.
// Writes assets/bundle-info.json with sha256 of every copied file so a reviewer can match it to the repo.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(pkg, "..", "..");
const assets = join(pkg, "assets");
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
// Recorded source paths are repo-relative (no absolute local paths in the published tarball); a source outside the
// repo (env override) is recorded as "<external>/<file name>".
const rel = (p) => {
  const r = relative(repo, p);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r.split("\\").join("/") : `<external>/${p.split(/[\\/]/).pop()}`;
};
const info = { builtAt: new Date().toISOString(), copied: {}, missing: [] };

const depSrc = process.env.ISOTHERM_BUNDLE_DEPLOYMENTS || join(repo, "deployments", "testnet.json");
const depDst = join(assets, "deployments.testnet.json");
if (existsSync(depSrc)) {
  const j = JSON.parse(readFileSync(depSrc, "utf8")); // must parse
  if (Number(j.chainId ?? 10143) !== 10143) throw new Error(`${depSrc}: chainId ${j.chainId} is not Monad testnet`);
  copyFileSync(depSrc, depDst);
  info.copied["deployments.testnet.json"] = { from: rel(depSrc), sha256: sha(depDst) };
} else {
  if (existsSync(depDst)) rmSync(depDst);
  info.missing.push(rel(depSrc));
}

const abiSrc = process.env.ISOTHERM_BUNDLE_ABI || join(repo, "packages", "abi");
const abiDst = join(assets, "abi");
rmSync(abiDst, { recursive: true, force: true });
if (existsSync(abiSrc)) {
  mkdirSync(abiDst, { recursive: true });
  for (const f of readdirSync(abiSrc).filter((f) => f.endsWith(".json"))) {
    const j = JSON.parse(readFileSync(join(abiSrc, f), "utf8"));
    const abi = Array.isArray(j) ? j : j.abi;
    if (!Array.isArray(abi)) continue; // not an ABI file (e.g. an index)
    writeFileSync(join(abiDst, f), JSON.stringify(abi));
    info.copied[`abi/${f}`] = { from: rel(join(abiSrc, f)), sha256: sha(join(abiDst, f)) };
  }
} else info.missing.push(rel(abiSrc));

writeFileSync(join(assets, "bundle-info.json"), JSON.stringify(info, null, 1) + "\n");
console.log(`bundle-assets: copied ${Object.keys(info.copied).length} file(s); missing: ${info.missing.length ? info.missing.join(", ") : "none"}`);
