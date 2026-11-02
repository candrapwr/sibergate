// One-off maintenance: slim bloated `requests.metadata` rows in the DB.
//
// Before slimRequestMetadata() landed, failed/failover requests stored the
// full upstream requestBody + requestHeaders + response body in the trail
// (a single row reached 1.3 MB). /admin/logs?limit=200 now slims on read,
// but the blobs still bloat sibergate.db itself. This script rewrites each
// metadata column with its slimmed form (same logic as the API), keeping
// only rows whose payload actually shrinks, then VACUUMs to reclaim space.
//
// The full diagnostics remain available on disk under request_traces/ (the
// drawer's "View raw request" link), so nothing operator-facing is lost.
//
// Usage (gateway must be STOPPED so the write lock is free):
//   npm run build:core && npx tsx scripts/slim-log-metadata.ts [--dry-run]
import { getDb, slimRequestMetadata } from '@sibergate/core';

const dryRun = process.argv.includes('--dry-run');
const db = getDb();

const rows = db.prepare('SELECT id, metadata FROM requests WHERE LENGTH(metadata) > 1').all() as Array<{
  id: number;
  metadata: string;
}>;

let changed = 0;
let beforeBytes = 0;
let afterBytes = 0;

const update = db.prepare('UPDATE requests SET metadata = ? WHERE id = ?');
const run = db.transaction(() => {
  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      continue; // malformed JSON — leave untouched
    }
    const slim = JSON.stringify(slimRequestMetadata(parsed));
    if (slim.length >= row.metadata.length) continue; // nothing gained
    beforeBytes += row.metadata.length;
    afterBytes += slim.length;
    changed += 1;
    if (!dryRun) update.run(slim, row.id);
  }
});
run();

console.log(
  `${dryRun ? '[dry-run] ' : ''}${rows.length} rows scanned, ${changed} to slim — ` +
    `metadata ${(beforeBytes / 1024 / 1024).toFixed(2)} MB → ${(afterBytes / 1024 / 1024).toFixed(2)} MB`,
);

if (!dryRun && changed > 0) {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  console.log('Done: WAL checkpointed and DB vacuumed.');
}
