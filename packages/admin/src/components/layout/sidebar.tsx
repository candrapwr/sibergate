'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Boxes,
  Cpu,
  Route,
  Network,
  Cloud,
  KeyRound,
  ScrollText,
  MessageSquare,
  BarChart3,
  Settings,
  RefreshCw,
  Clapperboard,
  LogOut,
  Users,
  Terminal,
  FileCode2,
  ChevronDown,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSystem, useReload } from '@/lib/queries';
import { useUser, useLogout } from '@/lib/auth-client';
import { toast } from 'sonner';

type NavLeaf = { href: string; label: string; icon: LucideIcon };
type NavGroup = { label: string; icon: LucideIcon; children: NavLeaf[] };
type NavItem = NavLeaf | NavGroup;

function isGroup(i: NavItem): i is NavGroup {
  return 'children' in i;
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/usage', label: 'Usage', icon: BarChart3 },
  { href: '/providers', label: 'Providers', icon: Boxes },
  { href: '/models', label: 'Models', icon: Cpu },
  { href: '/routes', label: 'Routes', icon: Route },
  {
    label: 'Proxy & Edge',
    icon: Network,
    children: [
      { href: '/proxy', label: 'Proxy Layer', icon: Network },
      { href: '/edge-relays', label: 'Edge Relays', icon: Cloud },
    ],
  },
  { href: '/custom-scripts', label: 'Custom Scripts', icon: FileCode2 },
  { href: '/api-keys', label: 'API Keys', icon: KeyRound },
  { href: '/users', label: 'Users', icon: Users },
  { href: '/logs', label: 'Logs', icon: ScrollText },
  { href: '/console', label: 'Console', icon: Terminal },
  { href: '/playground', label: 'Chat Playground', icon: MessageSquare },
  { href: '/playground/media', label: 'Media Lab', icon: Clapperboard },
  { href: '/settings', label: 'Settings', icon: Settings },
];

/** Semua href leaf (utk longest-prefix match). */
const ALL_LEAF_HREFS = NAV.flatMap((i) => (isGroup(i) ? i.children : [i])).map((l) => l.href);

/** Active = longest-prefix match wins. Without this, /playground/media would
 *  also highlight /playground (Chat) because it starts with it. */
function activeHref(pathname: string | null): string | null {
  if (!pathname) return null;
  const matches = ALL_LEAF_HREFS.filter((h) => pathname === h || pathname.startsWith(h + '/'));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** Leaf nav item (link langsung). */
function NavLeafItem({ leaf, pathname }: { leaf: NavLeaf; pathname: string | null }) {
  const active = activeHref(pathname) === leaf.href;
  const Icon = leaf.icon;
  return (
    <Link
      href={leaf.href}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors',
        active
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      <Icon size={15} />
      {leaf.label}
    </Link>
  );
}

/** Grup nav dgn submenu collapsible. Auto-expand bila child aktif. */
function NavGroupItem({ group, pathname }: { group: NavGroup; pathname: string | null }) {
  const childActive = activeHref(pathname);
  const isActive = group.children.some((c) => c.href === childActive);
  // Default: expand bila ada child aktif. User bisa toggle manual.
  const [open, setOpen] = useState(isActive);
  const Icon = group.icon;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors',
          isActive
            ? 'text-primary'
            : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        )}
      >
        <Icon size={15} />
        <span className="flex-1 text-left">{group.label}</span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 pl-3">
          {group.children.map((child) => (
            <NavLeafItem key={child.href} leaf={child} pathname={pathname} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { data: system } = useSystem();
  const { data: user } = useUser();
  const logout = useLogout();
  const reload = useReload();

  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-[hsl(220_13%_7%)]">
      {/* Brand */}
      <div className="flex shrink-0 items-center gap-2 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold">
          S
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">SiberGate</span>
          <span className="text-[10px] text-muted-foreground">Gateway Admin</span>
        </div>
      </div>

      {/* Nav — scrollable bila melebihi viewport. flex-1 + min-h-0 supaya
          flex child bisa shrink & trigger overflow (tanpa min-h-0, flex item
          default min-height: auto = tidak pernah overflow). */}
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {NAV.map((item) => {
          if (isGroup(item)) {
            return <NavGroupItem key={item.label} group={item} pathname={pathname} />;
          }
          return <NavLeafItem key={item.href} leaf={item} pathname={pathname} />;
        })}
      </nav>

      {/* Footer: counts + reload — tetap di bawah, tidak ikut scroll. */}
      <div className="shrink-0 border-t border-border p-3">
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
