// Seed runner — populates SQLite master data from sibergate.config.json.
import { seed } from '@sibergate/core';

seed().catch((err) => {
  console.error('[sibergate] seed failed:', err);
  process.exit(1);
});
