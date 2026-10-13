import { GatewayCallError, type AdapterCall } from '../provider.js';
import { mcpVideoSubmit } from '../mcp/media.js';

/**
 * Video generation — modality 'video' (OpenAI-style /v1/videos).
 *
 * v1 mendukung provider protocol='mcp' (mis. Kling text_to_video /
 * image_to_video): body OpenAI-style {model, prompt, seconds, size,
 * input_reference?} dipetakan ke arguments tool via inputSchema, lalu
 * tools/call dijalankan. Respons adapter = payload ternormalisasi
 * (taskRef/status/videoUrls/...) — handler /v1/videos yang membuat job row
 * dan membentuk objek video OpenAI (status queued/completed) darinya.
 *
 * Provider REST (OpenAI Sora dkk.) belum didukung — modality ini lahir utk
 * jalur MCP; passthrough REST menyusul saat ada kebutuhan.
 */
export async function video(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  if (provider.protocol !== 'mcp') {
    throw new GatewayCallError(
      'unsupported',
      `Video modality saat ini hanya mendukung provider MCP (target '${provider.id}' bukan provider MCP).`,
    );
  }
  const normalized = await mcpVideoSubmit(
    provider,
    model,
    call.toolMeta,
    { pollTool: provider.mcpOptions?.pollTool, pollToolArg: provider.mcpOptions?.pollToolArg },
    body,
    { signal, dispatcher: call.dispatcher },
  );
  return new Response(JSON.stringify(normalized), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
