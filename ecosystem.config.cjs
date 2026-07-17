/**
 * PM2 ecosystem — runs SiberGate gateway + admin dashboard together.
 *
 *   pm2 start ecosystem.config.cjs      # start both (gateway + admin)
 *   pm2 status                          # see them running
 *   pm2 logs sibergate                  # tail gateway logs (or 'sibergate-admin')
 *   pm2 logs                            # tail all
 *   pm2 restart all                     # reload after code/env change
 *   pm2 stop all / pm2 delete all       # stop / remove
 *   pm2 save && pm2 startup             # auto-start on boot (run once)
 *
 * Why .cjs: the project is "type": "module", so PM2's config must be CommonJS
 * (.cjs) to use module.exports. Both apps load their own .env: the gateway
 * reads <repo>/.env; the admin (Next.js) reads <repo>/packages/admin/.env.local.
 * Set SIBERGATE_ADMIN_PORT in packages/admin/.env.local to change its port.
 */
module.exports = {
  apps: [
    {
      name: 'sibergate',
      // Run the gateway via tsx (TypeScript direct, no compile step).
      // cwd = repo root so it picks up .env and ./sibergate.db.
      script: 'node_modules/.bin/tsx',
      args: 'packages/gateway/src/index.ts',
      cwd: __dirname,
      // Core must be built first (once): `npm run build:core`. PM2 will fail
      // loudly if it isn't — run that build before `pm2 start`.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/sibergate-out.log',
      error_file: './logs/sibergate-error.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'sibergate-admin',
      // Admin = Next.js production server. Requires `npm run build` once first
      // (so packages/admin/.next exists). Runs from packages/admin so Next.js
      // finds its .next + .env.local there.
      script: 'node_modules/.bin/next',
      args: 'start -p ${SIBERGATE_ADMIN_PORT:-3000}',
      cwd: `${__dirname}/packages/admin`,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/sibergate-admin-out.log',
      error_file: './logs/sibergate-admin-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
