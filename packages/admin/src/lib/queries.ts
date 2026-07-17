'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from './api-client';
import type {
  ApiKey,
  ListResponse,
  Model,
  Provider,
  RequestLog,
  Route,
  SystemInfo,
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
