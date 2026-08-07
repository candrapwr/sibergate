/**
 * Browser-side API client.
 *
 * Talks ONLY to the relative `/api/admin/*` Next.js proxy route — never to the
 * gateway directly. The admin key lives server-side and never appears here.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin/${path.replace(/^\//, '')}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const body = text ? safeParse(text) : undefined;

  if (!res.ok) {
    // Gateway error body bisa 2 bentuk:
    //   { error: { message: "..." } }   ← standar OpenAI-compat (admin CRUD)
    //   { ok: false, error: "..." }     ← edge relay / proxy routes (error sbg string)
    const errField = (body as { error?: unknown })?.error;
    const message =
      (typeof errField === 'string' ? errField : (errField as { message?: string })?.message) ??
      `Request failed (${res.status})`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: data ? JSON.stringify(data) : undefined }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PUT', body: data ? JSON.stringify(data) : undefined }),
  patch: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PATCH', body: data ? JSON.stringify(data) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
