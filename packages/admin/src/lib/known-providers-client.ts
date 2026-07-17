/**
 * Browser-safe stats for the known-providers catalog (count only).
 * The full catalog lives in @sibergate/core (server-side); we re-export just
 * the counts here to avoid bundling the large provider list into the client.
 */
export const KNOWN_STATS = { providers: 18, models: 206 } as const;
