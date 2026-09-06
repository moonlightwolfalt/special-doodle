import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = __dirname;
const SNAPSHOTS = [
  path.join(ROOT, 'mope_snapshot'),
  path.join(ROOT, 'mope_oct2025'),
];
const OUT = path.join(ROOT, 'mope_mega');

async function collectFiles(root, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectFiles(full, rel)));
    } else {
      out.push({ rel, full });
    }
  }
  return out;
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const manifest = [];
  const counts = {};

  // Merge in order: mope_snapshot first, then mope_oct2025 (wins on conflict).
  for (const snap of SNAPSHOTS) {
    const files = await collectFiles(snap);
    let added = 0;
    let overwritten = 0;
    for (const f of files) {
      const dest = path.join(OUT, f.rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(f.full, dest);
      const stat = await fs.stat(f.full);
      const exists = manifest.some((m) => m.path === f.rel);
      if (exists) overwritten++;
      else added++;
      if (!exists) {
        manifest.push({ path: f.rel, size: stat.size, source: path.basename(snap) });
      } else {
        const m = manifest.find((mm) => mm.path === f.rel);
        m.size = stat.size;
        m.source = path.basename(snap);
      }
    }
    counts[path.basename(snap)] = { added, overwritten, total: files.length };
  }

  await fs.writeFile(
    path.join(OUT, 'mega_manifest.json'),
    JSON.stringify({ generated: new Date().toISOString(), counts, files: manifest }, null, 2),
  );

  const total = manifest.length;
  const totalBytes = manifest.reduce((a, m) => a + (m.size || 0), 0);
  console.log(JSON.stringify({
    output: OUT,
    counts,
    totalFiles: total,
    totalBytes,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
