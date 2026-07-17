'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
}

/** Fetch the current logged-in user (or null). Used by the sidebar + guards. */
export function useUser() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await fetch('/api/auth/me');
      if (!res.ok) return null;
      const data = await res.json();
      return (data.user ?? null) as CurrentUser | null;
    },
    retry: false,
    staleTime: 60_000,
  });
}

/** Log out: clear session, then redirect to /login. */
export function useLogout() {
  const qc = useQueryClient();
  return async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    qc.clear();
    window.location.href = '/login';
  };
}
