import { sendUpstream, upstreamUrl, type AdapterCall } from '../provider.js';

/**
 * Music generation — inference-style providers (DeepInfra ACE-Step, etc.).
 *
 * Endpoint template uses `{model}`: e.g. "/v1/inference/{model}" resolves to
 * "/v1/inference/ACE-Step/acestep-v15-xl-sft".
 *
 * Request (DeepInfra-style):  { prompt, duration?, ... }  (model injected)
 * Response: { results: [{ audio: "data:audio/wav;base64,..." | url, ... }] }
 *
 * SiberGate normalizes the upstream response into a stable shape:
 *   { model, audio: <data-uri or url>, provider }
 * so clients don't have to know each vendor's envelope.
 */
export async function music(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const url = upstreamUrl(provider, 'music', model);
  const upstream = await sendUpstream({ url, provider, body: JSON.stringify({ ...body, model }), signal });

  // Normalize: extract the first audio artifact into a flat shape.
  try {
    const json = (await upstream.json()) as {
      results?: Array<{ audio?: string; audio_url?: string; url?: string }>;
      audio?: string;
      audio_url?: string;
    };
    const audio = json.results?.[0]?.audio ?? json.results?.[0]?.audio_url ?? json.audio ?? json.audio_url ?? '';
    return new Response(
      JSON.stringify({ model, provider: provider.id, audio }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch {
    // Couldn't parse — return upstream as-is so the client sees the raw response.
    return upstream;
  }
}
