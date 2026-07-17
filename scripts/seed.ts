// Seed runner — creates the first client API key + admin user.
// Providers/models/routes are managed via the admin UI (Import catalog).
import { seed } from '@sibergate/core';

seed().catch((err) => {
  console.error('[sibergate] seed failed:', err);
  process.exit(1);
});
