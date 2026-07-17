'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Boxes,
  Cpu,
  Route,
  KeyRound,
  ScrollText,
  MessageSquare,
  BarChart3,
  Settings,
  RefreshCw,
  Clapperboard,
  LogOut,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSystem, useReload } from '@/lib/queries';
import { useUser, useLogout } from '@/lib/auth-client';
import { toast } from 'sonner';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/usage', label: 'Usage', icon: BarChart3 },
  { href: '/providers', label: 'Providers', icon: Boxes },
  { href: '/models', label: 'Models', icon: Cpu },
  { href: '/routes', label: 'Routes', icon: Route },
  { href: '/api-keys', label: 'API Keys', icon: KeyRound },
  { href: '/logs', label: 'Logs', icon: ScrollText },
  { href: '/playground', label: 'Chat Playground', icon: MessageSquare },
  { href: '/playground/media', label: 'Media Lab', icon: Clapperboard },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: system } = useSystem();
  const { data: user } = useUser();
  const logout = useLogout();
  const reload = useReload();

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-border bg-[hsl(220_13%_7%)]">
      {/* Brand */}
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold">
          S
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">SiberGate</span>
          <span className="text-[10px] text-muted-foreground">Gateway Admin</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 px-2 py-2">
        {NAV.map((item) => {
          // Active = longest-prefix match wins. Without this, /playground/media
          // would also highlight /playground (Chat) because it starts with it.
          const matches = NAV.filter(
            (n) => pathname === n.href || pathname?.startsWith(n.href + '/'),
          );
          const longest = matches.sort((a, b) => b.href.length - a.href.length)[0];
          const active = longest?.href === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors',
                active
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              <Icon size={15} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer: counts + reload */}
      <div className="border-t border-border p-3">
        <div className="mb-2 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground">
          <span>Providers</span>
          <span className="text-right text-foreground">{system?.providers ?? '—'}</span>
          <span>Models</span>
          <span className="text-right text-foreground">{system?.models ?? '—'}</span>
          <span>Routes</span>
          <span className="text-right text-foreground">{system?.routes ?? '—'}</span>
          <span>Keys</span>
          <span className="text-right text-foreground">{system?.apiKeys ?? '—'}</span>
        </div>
        <button
          type="button"
          onClick={() => reload.mutateAsync().then(() => toast.success('Config reloaded'))}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <RefreshCw size={12} className={reload.isPending ? 'animate-spin' : ''} />
          Reload config
        </button>

        {/* Signed-in user + logout */}
        {user ? (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[10px] font-semibold text-primary">
              {(user.name || user.email).slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-medium">{user.name || user.email}</div>
              <div className="truncate text-[10px] text-muted-foreground">{user.email}</div>
            </div>
            <button
              type="button"
              onClick={() => logout()}
              title="Sign out"
              className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-destructive"
            >
              <LogOut size={13} />
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
