'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from './sidebar';

/**
 * Conditionally renders the sidebar shell.
 *
 * Auth-related pages (login) render bare without the sidebar; every other
 * route gets the full dashboard shell (sidebar + centered content).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = pathname === '/login';

  if (isAuthPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-6">{children}</div>
      </main>
    </div>
  );
}
