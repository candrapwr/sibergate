import { sendUpstream, upstreamUrl, type AdapterCall } from '../provider.js';

/**
 * Generic passthrough — proxy any non-LLM REST API verbatim.
 *
 * Unlike the OpenAI-shaped adapters, this makes NO assumptions about the
 * upstream's request/response shape: it forwards the original HTTP method,
 * headers, and body bytes unchanged, and returns the upstream response as-is.
 * The endpoint template (provider.endpoints.generic) may use `{model}`,
 * `{model_id}`, or `{path}` placeholders; `{path}` is the request path suffix
 * after the route id (see the gateway's /v1/proxy/:routeId/* handler).
 *
 * The gateway sets these special body fields before calling the adapter:
 *   __raw         — the raw request body bytes (string | Buffer | Uint8Array)
 *   __contentType — the original Content-Type header
 *   __method      — the original HTTP method (GET/POST/PUT/PATCH/DELETE)
 *   __path        — the path suffix to splice into the `{path}` placeholder
 *
 * For requests with no body (e.g. GET), __raw is empty and body is {} — that's
 * fine; sendUpstream receives an empty string.
 */
export async function generic(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const method = (body.__method as string) ?? 'POST';
  const url = upstreamUrl(provider, 'generic', model, body.__path as string | undefined);
  const raw = body.__raw as BodyInit | undefined;
  const hasRaw = raw !== undefined && raw !== null && raw !== '';

  // GET/HEAD must carry no body. For other methods, forward the raw bytes when
  // present, otherwise a JSON serialization of the parsed body.
  let reqBody: BodyInit | undefined;
  let contentType: string | undefined;
  if (method === 'GET' || method === 'HEAD') {
    reqBody = undefined;
    contentType = undefined;
  } else if (hasRaw) {
    reqBody = raw!;
    contentType = body.__contentType as string;
  } else {
    reqBody = JSON.stringify({ ...body, model });
    contentType = 'application/json';
  }

  return sendUpstream({
    url,
    provider,
    body: reqBody as BodyInit,
    signal,
    method,
    contentType,
  });
}
