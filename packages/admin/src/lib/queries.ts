'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from './api-client';
import type {
  ApiKey,
  CustomScript,
  CustomScriptSummary,
  GeoIpStatus,
  ListResponse,
  Model,
  Provider,
  ProviderKey,
  ProviderProxyBinding,
  ProxyLogEntry,
  ProxyPool,
  ProxyPoolMember,
  ProxyStrategy,
  ProxyTestResult,
  RequestLog,
  Route,
  ScriptRunResult,
  SystemInfo,
  User,
  UsageMatrixRow,
  UsageStats,
} from './types';

/* ──────────────────────────── Read queries ──────────────────────────── */

export function useSystem() {
  return useQuery({
    queryKey: ['system'],
    queryFn: () => api.get<SystemInfo>('system'),
    refetchInterval: 15_000,
  });
}

export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: () => api.get<UsageStats>('stats'),
    refetchInterval: 10_000,
  });
}

export function useUsageMatrix() {
  return useQuery({
    queryKey: ['usage'],
    queryFn: () => api.get<ListResponse<UsageMatrixRow>>('usage'),
    refetchInterval: 15_000,
  });
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ListResponse<Provider>>('providers'),
  });
}

export function useModels() {
  return useQuery({
    queryKey: ['models'],
    queryFn: () => api.get<ListResponse<Model>>('models'),
  });
}

export function useRoutes() {
  return useQuery({
    queryKey: ['routes'],
    queryFn: () => api.get<ListResponse<Route>>('routes'),
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get<ListResponse<ApiKey>>('api-keys'),
  });
}

export function useLogs(limit = 100) {
  return useQuery({
    queryKey: ['logs', limit],
    queryFn: () => api.get<ListResponse<RequestLog>>(`logs?limit=${limit}`),
    refetchInterval: 10_000,
  });
}

/* ─────────────────────────── Provider mutations ─────────────────────── */

export function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Provider> & { apiKey?: string }) => api.post<Provider>('providers', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Provider> & { apiKey?: string } }) =>
      api.patch<Provider>(`providers/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`providers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

export function useToggleProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`providers/${id}`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

/* ──────────────────────── Provider keys (multi-account) ────────────────── */

/** Upstream API keys milik sebuah provider. QueryKey sertakan providerId supaya
 *  cache terpisah per provider. */
export function useProviderKeys(providerId: string | null | undefined) {
  return useQuery({
    queryKey: ['provider-keys', providerId],
    queryFn: () => api.get<ListResponse<ProviderKey>>(`providers/${providerId}/keys`),
    enabled: !!providerId,
  });
}

export function useCreateProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, label, apiKey }: { providerId: string; label: string; apiKey: string }) =>
      api.post<ProviderKey>(`providers/${providerId}/keys`, { label, apiKey }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['provider-keys', vars.providerId] });
      // Provider.keyCount berubah → refresh list provider juga.
      qc.invalidateQueries({ queryKey: ['providers'] });
    },
  });
}

export function useUpdateProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      providerId,
      keyId,
      data,
    }: {
      providerId: string;
      keyId: string;
      data: { label?: string; enabled?: boolean; apiKey?: string };
    }) => api.patch<ProviderKey>(`providers/${providerId}/keys/${keyId}`, data),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['provider-keys', vars.providerId] });
    },
  });
}

export function useDeleteProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, keyId }: { providerId: string; keyId: string }) =>
      api.delete(`providers/${providerId}/keys/${keyId}`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['provider-keys', vars.providerId] });
      qc.invalidateQueries({ queryKey: ['providers'] });
    },
  });
}

/** Tandai sebuah key sebagai default provider-nya (clear default lainnya). */
export function useSetDefaultProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, keyId }: { providerId: string; keyId: string }) =>
      api.post<ProviderKey>(`providers/${providerId}/keys/${keyId}/default`, {}),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['provider-keys', vars.providerId] });
    },
  });
}

/* ──────────────────────────── Model mutations ───────────────────────── */

export function useUpsertModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Model>) =>
      data.id && (data as any).__edit
        ? api.put<Model>(`models/${data.id}`, data)
        : api.post<Model>('models', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

export function useDeleteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`models/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

export function useToggleModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`models/${id}`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

/* ──────────────────────────── Route mutations ───────────────────────── */

export function useUpsertRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Route>) =>
      data.id && (data as any).__edit
        ? api.put<Route>(`routes/${data.id}`, data)
        : api.post<Route>('routes', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routes'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

export function useDeleteRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`routes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routes'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

export function useToggleRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`routes/${id}`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routes'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

/* ─────────────────────────── API key mutations ──────────────────────── */

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<ApiKey>('api-keys', { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api-keys'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

/** Rotate an existing key's secret; returns the new plaintext once. */
export function useRegenerateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ApiKey>(`api-keys/${id}/regenerate`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
}

export function useToggleApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`api-keys/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
}

export function useDeleteApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`api-keys/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api-keys'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

export function useReload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('reload'),
    onSuccess: () => qc.invalidateQueries(),
  });
}

/* ──────────────────────────── User management ────────────────────────── */

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<ListResponse<User>>('users'),
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { email: string; name: string; password: string; role?: string }) =>
      api.post<User>('users', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; role?: string; password?: string; status?: 'active' | 'disabled' } }) =>
      api.patch(`users/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

/* ──────────────────────────── Bulk operations ───────────────────────── */

export interface ImportResult {
  ok: boolean;
  providersImported: number;
  providersSkipped: number;
  modelsImported: number;
  modelsSkipped: number;
}

export function useImportProviders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ImportResult>('import-providers'),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export interface ResetResult {
  ok: boolean;
  removed: { providers: number; models: number; routes: number; apiKeys: number; logs: number };
}

export function useResetAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ResetResult>('reset', { confirm: 'DELETE_EVERYTHING' }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

/** Hapus semua baris di tabel requests (request log). Master data aman. */
export function useClearLogs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean; removed: { logs: number } }>('logs/clear'),
    onSuccess: () => {
      // Hanya invalidate query yg membaca requests/logs/stats — bukan semua cache.
      qc.invalidateQueries({ queryKey: ['logs'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['usage'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

/** Reset stats = clear logs + reset latency EMA. Master data aman. */
export function useResetStats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; removed: { logs: number; latencyEntries: number } }>('stats/reset'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['logs'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['usage'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

/* ─────────────────── Signature cache (Gemini tool calls) ─────────────────── */

export interface SignatureCacheEntry {
  id: string;
  providerId: string;
  ageMs: number;
}
export interface SignatureCache {
  count: number;
  entries: SignatureCacheEntry[];
}

/** Snapshot cache signature utk monitoring (count + 50 sample entries). */
export function useSignatures() {
  return useQuery({
    queryKey: ['signatures'],
    queryFn: () => api.get<SignatureCache>('signatures'),
    refetchInterval: 15_000,
  });
}

/** Hapus semua signature dari cache (Gemini thought_signature). */
export function useClearSignatures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean; removed: { cleared: number } }>('signatures/clear'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['signatures'] });
    },
  });
}

/* ──────────────────────────── Custom Scripts ──────────────────────────── */

export function useCustomScripts() {
  return useQuery({
    queryKey: ['custom-scripts'],
    queryFn: () => api.get<ListResponse<CustomScriptSummary>>('custom-scripts'),
  });
}

export function useCustomScript(id: string | null | undefined) {
  return useQuery({
    queryKey: ['custom-scripts', id],
    queryFn: () => api.get<CustomScript>(`custom-scripts/${id}`),
    enabled: !!id,
  });
}

export function useCreateCustomScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<CustomScript> & { id: string; script: string }) =>
      api.post<CustomScript>('custom-scripts', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-scripts'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

export function useUpdateCustomScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CustomScript> }) =>
      api.patch<CustomScript>(`custom-scripts/${id}`, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['custom-scripts'] });
      qc.invalidateQueries({ queryKey: ['custom-scripts', vars.id] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

export function useDeleteCustomScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`custom-scripts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-scripts'] });
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
}

/** Run a saved script with a test input (used by the editor Test panel). */
export function useTestCustomScript() {
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: string }) =>
      api.post<ScriptRunResult>(`custom-scripts/${id}/test`, { input }),
  });
}

/* ──────────────────────────── Proxy Layer ──────────────────────────── */

export function useProxyPools() {
  return useQuery({
    queryKey: ['proxy-pools'],
    queryFn: () => api.get<ListResponse<ProxyPool>>('proxy/pools'),
  });
}

export function useCreateProxyPool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; name?: string; strategy?: ProxyStrategy; enabled?: boolean }) =>
      api.post<ProxyPool>('proxy/pools', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proxy-pools'] }),
  });
}

export function useUpdateProxyPool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ProxyPool> }) =>
      api.patch<ProxyPool>(`proxy/pools/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proxy-pools'] }),
  });
}

export function useDeleteProxyPool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`proxy/pools/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proxy-pools'] }),
  });
}

/** Members of a pool. */
export function usePoolMembers(poolId: string | null | undefined) {
  return useQuery({
    queryKey: ['proxy-members', poolId],
    queryFn: () => api.get<ListResponse<ProxyPoolMember>>(`proxy/pools/${poolId}/members`),
    enabled: !!poolId,
  });
}

export function useAddPoolMember(poolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { proxyUrl: string; label?: string; weight?: number; enabled?: boolean }) =>
      api.post<ProxyPoolMember>(`proxy/pools/${poolId}/members`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['proxy-members', poolId] });
      qc.invalidateQueries({ queryKey: ['proxy-pools'] });
    },
  });
}

export function useUpdatePoolMember(poolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, data }: { memberId: number; data: Partial<ProxyPoolMember> }) =>
      api.patch<ProxyPoolMember>(`proxy/pools/${poolId}/members/${memberId}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proxy-members', poolId] }),
  });
}

export function useDeletePoolMember(poolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: number) => api.delete(`proxy/pools/${poolId}/members/${memberId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['proxy-members', poolId] });
      qc.invalidateQueries({ queryKey: ['proxy-pools'] });
    },
  });
}

/** Test a member (connectivity + latency + exit IP + geoip flag). */
export function useTestPoolMember(poolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: number) => api.post<ProxyTestResult>(`proxy/pools/${poolId}/members/${memberId}/test`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['proxy-members', poolId] });
    },
  });
}

/** Provider bindings for a pool (which providers route through it). */
export function usePoolBindings(poolId: string | null | undefined) {
  return useQuery({
    queryKey: ['proxy-bindings', poolId],
    queryFn: () => api.get<ListResponse<ProviderProxyBinding>>(`proxy/pools/${poolId}/bindings`),
    enabled: !!poolId,
  });
}

export function useBindProvider(poolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, enabled }: { providerId: string; enabled: boolean }) =>
      api.post(`proxy/pools/${poolId}/bindings`, { providerId, enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['proxy-bindings', poolId] });
      qc.invalidateQueries({ queryKey: ['proxy-pools'] });
    },
  });
}

export function useUnbindProvider(poolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) => api.delete(`proxy/pools/${poolId}/bindings/${providerId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['proxy-bindings', poolId] });
      qc.invalidateQueries({ queryKey: ['proxy-pools'] });
    },
  });
}

/** Proxy event logs. */
export function useProxyLogs(limit = 100) {
  return useQuery({
    queryKey: ['proxy-logs', limit],
    queryFn: () => api.get<ListResponse<ProxyLogEntry>>(`proxy/logs?limit=${limit}`),
    refetchInterval: 10_000,
  });
}

/** GeoIP DB status + update. */
export function useGeoIpStatus() {
  return useQuery({ queryKey: ['proxy-geoip'], queryFn: () => api.get<GeoIpStatus>('proxy/geoip/status') });
}

export function useUpdateGeoIp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url?: string) => api.post<{ ok: boolean; sizeBytes?: number; error?: string; url?: string }>('proxy/geoip/update', url ? { url } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proxy-geoip'] }),
  });
}
