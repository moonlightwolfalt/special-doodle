#!/usr/bin/env bun
/**
 * fetch_mope_bun.ts - Bulk-download mope.io files from the Wayback Machine.
 *
 * Uses the mope.io snapshot closest to October 29th, 2025 (per-file: each URL
 * is fetched at the Wayback timestamp nearest that date).
 *
 * Sources of file URLs:
 *   1. Directory listings (all files & subfolders) for /assets, /img, /skins, /shop
 *      enumerated through the Wayback CDX API.
 *   2. Every image/file path referenced inside client.js (hex-escaped strings
 *      are decoded first).
 *   3. Same-host assets referenced by the homepage HTML.
 *
 * Features:
 *   - parallel downloading with configurable concurrency (default 20)
 *   - verbose logging (default on)
 *   - retries with exponential backoff
 *   - resume support (skips already-downloaded files)
 *   - manifest.json with the results
 *
 * Usage:
 *   bun run fetch_mope_bun.ts --concurrency 20 -o mope_oct2025
 *   bun run fetch_mope_bun.ts --date 2025-10-29 --limit 50   # smoke test
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// --------------------------------------------------------------------------
// Configuration & CLI parsing
// --------------------------------------------------------------------------

const BASE = "https://mope.io";
const CDX = "https://web.archive.org/cdx/search/cdx";
const WEB = "https://web.archive.org/web";
const UA = "mope-archive-bun/1.0 (+https://web.archive.org/robots.txt)";
const FOLDERS = ["assets", "img", "skins", "shop"];
const WINDOW_DAYS = 400; // CDX search window around the target date
const MAX_RETRIES = 6;

const argv = process.argv.slice(2);

function argValue(flag: string, dflt: string): string {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(flag + "="));
  if (eq) return eq.slice(flag.length + 1);
  return dflt;
}

const TARGET_DATE = argValue("--date", "2025-10-29");
const CONCURRENCY = Math.max(1, parseInt(argValue("--concurrency", "20"), 10) || 20);
const OUT_DIR = argValue("--output", argValue("-o", "mope_oct2025"));
const LIMIT = parseInt(argValue("--limit", "0"), 10) || 0;
const VERBOSE = !argv.includes("--quiet");

// --------------------------------------------------------------------------
// Logging (verbose by default)
// --------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(msg: string): void {
  if (VERBOSE) console.log(`[mope ${ts()}] ${msg}`);
}

function warn(msg: string): void {
  console.log(`[mope ${ts()}] WARN ${msg}`);
}

// --------------------------------------------------------------------------
// Date / Wayback timestamp helpers
// --------------------------------------------------------------------------

function parseTargetDate(text: string): Date {
  const digits = text.replace(/\D/g, "");
  const y = parseInt(digits.slice(0, 4), 10);
  const m = parseInt(digits.slice(4, 6), 10);
  const d = parseInt(digits.slice(6, 8), 10);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtWayback(d: Date): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

const targetDate = parseTargetDate(TARGET_DATE);
const WAYBACK_TS = fmtWayback(targetDate);

function windowAroundTarget(): [string, string] {
  const ms = WINDOW_DAYS * 86400000;
  return [fmtWayback(new Date(targetDate.getTime() - ms)),
          fmtWayback(new Date(targetDate.getTime() + ms))];
}

function tsNum(ts: string): number {
  return parseInt(ts, 10) || 0;
}

// --------------------------------------------------------------------------
// HTTP helpers (retry with exponential backoff)
// --------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpGet(url: string): Promise<{ status: number; finalUrl: string; buf: Buffer }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let res = await fetch(url, {
        redirect: "manual",
        headers: { "User-Agent": UA },
      });
      // Follow redirects manually (bun's auto-follow rejects some Wayback
      // protocol switches, e.g. https -> http on the archived URL).
      let currentUrl = url;
      let hops = 0;
      while (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        if (++hops > 5) throw new Error("too many redirects");
        currentUrl = new URL(loc, currentUrl).toString();
        res = await fetch(currentUrl, {
          redirect: "manual",
          headers: { "User-Agent": UA },
        });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, finalUrl: currentUrl, buf };
    } catch (e) {
      lastErr = e;
      const backoff = Math.min(30000, 1000 * 2 ** (attempt - 1));
      log(`  retry ${attempt}/${MAX_RETRIES} after ${backoff}ms: ${url} (${e})`);
      await sleep(backoff);
    }
  }
  throw new Error(`GET ${url} failed: ${String(lastErr)}`);
}

// --------------------------------------------------------------------------
// Wayback CDX API
// --------------------------------------------------------------------------

async function cdxQuery(
  url: string,
  matchType: "prefix" | "exact" = "prefix",
  opts: { limit?: number; from?: string; to?: string; collapse?: string; filter?: string } = {},
): Promise<string[][]> {
  const p = new URLSearchParams({
    url,
    matchType,
    output: "json",
    limit: String(opts.limit ?? 10000),
    fl: "timestamp,original,statuscode,mimetype,digest,length",
  });
  if (opts.from) p.set("from", opts.from);
  if (opts.to) p.set("to", opts.to);
  if (opts.collapse) p.set("collapse", opts.collapse);
  if (opts.filter) p.set("filter", opts.filter);

  const q = `${CDX}?${p.toString()}`;
  log(`CDX ${matchType} ${url}`);
  const { status, buf } = await httpGet(q);
  if (status !== 200) {
    warn(`CDX query returned HTTP ${status}: ${q}`);
    return [];
  }
  const text = buf.toString("utf8").trim();
  if (!text) return [];
  const rows = JSON.parse(text) as unknown;
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return (rows as string[][]).slice(1); // drop header row
}

// --------------------------------------------------------------------------
// URL sources
// --------------------------------------------------------------------------

/** Enumerate every archived file under /<folder> (all subfolders). */
async function enumerateFolder(folder: string): Promise<string[]> {
  const [from, to] = windowAroundTarget();
  const rows = await cdxQuery(`mope.io/${folder}`, "prefix", {
    from, to, collapse: "urlkey", limit: 50000, filter: "statuscode:200",
  });
  const urls = new Set<string>();
  for (const r of rows) {
    const orig = (r[1] || "").trim();
    if (!orig || !orig.startsWith("http")) continue;
    urls.add(orig.startsWith("http://") ? "https://" + orig.slice(7) : orig);
  }
  const list = [...urls].sort();
  log(`folder /${folder}: ${list.length} unique files`);
  return list;
}

/** Locate the client.js capture closest to the target date. */
async function findClientJsSnapshot(): Promise<{ ts: string; url: string } | null> {
  const [from, to] = windowAroundTarget();
  const rows = await cdxQuery(`mope.io/client.js`, "prefix", {
    from, to, limit: 5000, filter: "statuscode:200",
  });
  let best: { ts: string; url: string } | null = null;
  let bestGap = Infinity;
  for (const r of rows) {
    const ts = r[0];
    const orig = (r[1] || "").trim();
    if (!ts || !orig) continue;
    const gap = Math.abs(tsNum(ts) - tsNum(WAYBACK_TS));
    if (gap < bestGap) {
      bestGap = gap;
      best = { ts, url: orig };
    }
  }
  return best;
}

/** Extract asset paths from client.js (decoding \xNN escapes first). */
async function extractClientJsAssets(): Promise<string[]> {
  const snap = await findClientJsSnapshot();
  if (!snap) {
    warn("no archived client.js found near target date");
    return [];
  }
  log(`client.js: closest capture ${snap.ts} (${snap.url})`);
  const { status, buf } = await httpGet(`${WEB}/${snap.ts}id_/${snap.url}`);
  if (status !== 200) {
    warn(`client.js download HTTP ${status}`);
    return [];
  }
  // save a local copy of client.js too
  const dest = join(OUT_DIR, safePath(snap.url));
  await writeFileIfMissing(dest, buf);

  const text = buf.toString("utf8");
  const decoded = text.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) =>
    String.fromCharCode(parseInt(h, 16)),
  );
  const pathRe =
    /((?:[A-Za-z0-9_]+\/)+[A-Za-z0-9_\-]+\.(?:png|jpe?g|webp|gif|mp3|ogg|wav|json|svg|ttf|woff2?|dat|xml|glb|obj|mtl|bin|js|css))/g;
  const knownDirs = /^(?:assets|img|skins|shop|audio|sounds|fonts|ui_build|js)\//;
  const found = new Set<string>();
  for (const m of decoded.matchAll(pathRe)) {
    const p = m[1];
    if (!knownDirs.test(p)) continue;
    found.add(`${BASE}/${p}`);
  }
  const list = [...found].sort();
  log(`client.js: ${list.length} asset references found`);
  return list;
}

/** Same-host assets referenced by the homepage at the target snapshot. */
async function extractHomepageAssets(): Promise<string[]> {
  const url = `${WEB}/${WAYBACK_TS}id_/${BASE}/`;
  log(`homepage: ${WAYBACK_TS}`);
  const { status, buf } = await httpGet(url);
  if (status !== 200) {
    warn(`homepage HTTP ${status}`);
    return [];
  }
  await writeFileIfMissing(join(OUT_DIR, "index.html"), buf);
  const html = buf.toString("utf8");
  const found = new Set<string>();
  const refRe = /(?:src|href)=["']([^"']+)["']/g;
  for (const m of html.matchAll(refRe)) {
    const ref = m[1].trim();
    if (!ref || ref.startsWith("data:") || ref.startsWith("#") || ref.startsWith("//") ||
        ref.startsWith("mailto:") || ref.includes("cdn-cgi") || ref.includes("cloudflare") ||
        ref.includes("beacon")) {
      continue;
    }
    let full: string;
    try {
      full = new URL(ref, BASE + "/").toString();
    } catch {
      continue;
    }
    if (full.startsWith(BASE)) found.add(full);
  }
  const list = [...found].sort();
  log(`homepage: ${list.length} same-host asset references`);
  return list;
}

// --------------------------------------------------------------------------
// Download helpers
// --------------------------------------------------------------------------

function safePath(url: string): string {
  const u = new URL(url);
  let path = u.pathname.replace(/^\/+/, "");
  if (!path) path = "index.html";
  const parts = path.split("/").map((p) => p.replace(/[^A-Za-z0-9._-]/g, "_"));
  if (u.search) {
    const q = u.search.slice(1).replace(/[^A-Za-z0-9._-]/g, "_");
    parts[parts.length - 1] += "_" + q;
  }
  return parts.join("/");
}

async function writeFileIfMissing(dest: string, buf: Buffer): Promise<boolean> {
  if (existsSync(dest) && (await stat(dest)).size > 0) return false;
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return true;
}

/** Download one URL at the Wayback snapshot closest to the target date. */
async function downloadOne(url: string): Promise<{ ok: boolean; error?: string }> {
  const rel = safePath(url);
  const dest = join(OUT_DIR, rel);
  if (existsSync(dest) && (await stat(dest)).size > 0) {
    log(`[skip] ${rel} (already present)`);
    return { ok: true };
  }
  const wbUrl = `${WEB}/${WAYBACK_TS}id_/${url}`;
  const t0 = Date.now();
  try {
    const { status, finalUrl, buf } = await httpGet(wbUrl);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const wrote = await writeFileIfMissing(dest, buf);
    const snapTs = finalUrl.match(/\/web\/(\d{14})/)?.[1] ?? "?";
    if (wrote) {
      log(`[ok]   ${rel} ${buf.length} bytes (${Date.now() - t0}ms, snap ${snapTs})`);
    } else {
      log(`[skip] ${rel} (already present)`);
    }
    return { ok: true };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    log(`[FAIL] ${rel} (${msg})`);
    return { ok: false, error: msg };
  }
}

/** Run *worker* over *items* with at most *concurrency* in flight (parallel). */
async function runPool<T>(items: T[], worker: (item: T) => Promise<void>, concurrency: number): Promise<void> {
  let idx = 0;
  let done = 0;
  async function run(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      await worker(items[i]);
      done++;
      if (done % 100 === 0) log(`progress: ${done}/${items.length} done`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => run()));
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`target date: ${TARGET_DATE} (wayback ts ${WAYBACK_TS})`);
  log(`concurrency: ${CONCURRENCY}, parallel downloading: enabled`);
  log(`output dir: ${OUT_DIR}`);
  await mkdir(OUT_DIR, { recursive: true });

  // 1. Collect every candidate URL.
  const all = new Set<string>();
  for (const folder of FOLDERS) {
    for (const u of await enumerateFolder(folder)) all.add(u);
  }
  for (const u of await extractClientJsAssets()) all.add(u);
  for (const u of await extractHomepageAssets()) all.add(u);

  let urls = [...all].filter((u) => u.startsWith(BASE + "/") || u === BASE + "/");
  urls.sort();
  if (LIMIT > 0) urls = urls.slice(0, LIMIT);
  log(`total unique URLs to download: ${urls.length}`);

  // 2. Download everything in parallel.
  const failures: Array<{ url: string; error: string }> = [];
  const tStart = Date.now();
  await runPool(urls, async (u) => {
    const r = await downloadOne(u);
    if (!r.ok) failures.push({ url: u, error: r.error || "unknown" });
  }, CONCURRENCY);

  // 3. Summary + manifest.
  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  let downloaded = 0;
  let skipped = 0;
  for (const u of urls) {
    if (existsSync(join(OUT_DIR, safePath(u)))) downloaded++;
  }
  skipped = urls.length - downloaded;
  log("--------------------------------------------------");
  log(`done in ${elapsed}s`);
  log(`total files:      ${urls.length}`);
  log(`downloaded/ok:    ${downloaded}`);
  log(`skipped (resume): ${skipped - failures.length}`);
  log(`failed:           ${failures.length}`);
  if (failures.length) {
    warn("failed URLs (will be retried on next run):");
    for (const f of failures.slice(0, 25)) warn(`  - ${f.url} (${f.error})`);
  }

  const manifest = {
    target_date: TARGET_DATE,
    wayback_ts: WAYBACK_TS,
    concurrency: CONCURRENCY,
    elapsed_seconds: elapsed,
    urls_discovered: urls.length,
    downloaded,
    failed: failures.length,
    files: [...urls].map((u) => ({ url: u, local_path: safePath(u) })),
  };
  await writeFile(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`manifest written to ${join(OUT_DIR, "manifest.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
