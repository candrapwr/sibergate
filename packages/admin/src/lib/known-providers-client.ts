/**
 * Browser-safe stats for the known-providers catalog (count only).
 * The full catalog lives in @sibergate/core (server-side); we re-export just
 * the counts here to avoid bundling the large provider list into the client.
 * (kling-mcp = provider MCP pertama; tools-nya di-sync live, bukan preset.)
 */
export const KNOWN_STATS = { providers: 19, models: 206 } as const;
