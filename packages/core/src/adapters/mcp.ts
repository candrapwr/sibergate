import { GatewayCallError, type AdapterCall } from '../provider.js';
import { callToolNormalized } from '../mcp/media.js';

/**
 * Generic MCP tool invocation — modality 'mcp' (POST /v1/mcp/{route}/tools/{tool}).
 *
 * Body request adalah arguments tool apa adanya (atau wrapper {"arguments": {...}}).
 * Nama tool di-inject handler gateway ke body.__mcpTool (dari URL) — jalur ini
 * TIDAK memetakan argumen (klien memanggil tool MCP secara langsung dan mengetahui
 * schema-nya). Respons = hasil tools/call ternormalisasi:
 *   { object:'mcp_tool_call', tool, isError, text, content, structured,
 *     taskRef, taskStatus, status, imageUrls, videoUrls, otherUrls }
 */
export async function mcp(call: AdapterCall): Promise<Response> {
  const { provider, body, signal } = call;
  if (provider.protocol !== 'mcp') {
    throw new GatewayCallError(
      'unsupported',
      `Route MCP hanya bisa menargetkan provider protocol='mcp' (target '${provider.id}' bukan provider MCP).`,
    );
  }
  const tool = String(body.__mcpTool ?? '');
  if (!tool) {
    throw new GatewayCallError('client_error', 'Nama tool MCP tidak ditemukan di request (internal: __mcpTool kosong).');
  }
  let args: Record<string, unknown>;
  if (body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)) {
    args = body.arguments as Record<string, unknown>;
  } else {
    const { __mcpTool: _tool, ...rest } = body;
    args = rest;
  }
  const normalized = await callToolNormalized(provider, tool, args, {
    signal,
    dispatcher: call.dispatcher,
  });
  return new Response(
    JSON.stringify({ object: 'mcp_tool_call', ...normalized }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
