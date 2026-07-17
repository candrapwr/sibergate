import { randomUUID } from 'node:crypto';
import { loadDotEnv } from './env.js';
import { getDb } from './db.js';
import { generateApiKey } from './api-key.js';
import { createUser, userCount } from './auth.js';

/**
 * Seed the minimal bootstrap data for SiberGate.
 *
 * Since providers/models/routes can be managed via the admin UI (Import
 * Catalog + CRUD), this seed only creates:
 *   1. A client API key (for testing the /v1/* gateway)  — if none exist.
 *   2. The first admin panel user                        — from env.
 *
 * Providers, models, and routes are NOT seeded here. Use the admin UI
 * (Settings → Import catalog) after logging in.
 */
export async function seed(): Promise<void> {
  await loadDotEnv();
  const db = getDb();

  // 1. Client API key — issue one if none exist yet.
  const keyCount = (
    db.prepare('SELECT COUNT(*) as c FROM api_keys').get() as { c: number }
  ).c;
  if (keyCount === 0) {
    const k = generateApiKey();
    db.prepare(
      'INSERT INTO api_keys (id, name, key_hash, key_prefix, enabled) VALUES (?, ?, ?, ?, 1)',
    ).run(randomUUID(), 'default', k.hash, k.prefix);
    console.log('\n──────────────────────────────────────────');
    console.log(' ✅ Client API key (shown ONCE):');
    console.log('──────────────────────────────────────────');
    console.log(`   ${k.plaintext}`);
    console.log('──────────────────────────────────────────');
  } else {
    console.log('\n✅ Client API key already exists.');
  }

  // 2. Admin panel user — create from env if none exist.
  if (userCount() === 0) {
    const email = process.env.SIBERGATE_ADMIN_EMAIL;
    const password = process.env.SIBERGATE_ADMIN_PASSWORD;
    if (email && password) {
      createUser({ email, name: 'Administrator', password, role: 'owner' });
      console.log(` ✅ Admin user created: ${email}`);
      console.log('    Log in at the admin panel with this email + SIBERGATE_ADMIN_PASSWORD.');
    } else {
      console.log(
        ' ⚠️  No admin user created (set SIBERGATE_ADMIN_EMAIL + SIBERGATE_ADMIN_PASSWORD in .env).',
      );
    }
  } else {
    console.log('✅ Admin user already exists.');
  }

  console.log(
    '\n💡 Tip: import providers/models via the admin UI → Settings → Import catalog.\n',
  );
}
