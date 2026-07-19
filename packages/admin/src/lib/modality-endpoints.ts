/**
 * Map a route modality to its gateway endpoint path and the proxy path used by
 * the admin UI. Code-sample generators and the route tester both use this so
 * they work for every modality (chat, image, speech, music, …), not just chat.
 */

export interface ModalityEndpoint {
  /** Gateway path, e.g. "/v1/chat/completions" */
  path: string;
  /** Admin UI proxy path (same as gateway, served by Next.js proxy routes) */
  proxyPath: string;
  /** Human label for the modality */
  label: string;
}

const MAP: Record<string, ModalityEndpoint> = {
  chat: { path: '/v1/chat/completions', proxyPath: '/v1/chat/completions', label: 'Chat' },
  image: { path: '/v1/images/generations', proxyPath: '/v1/images/generations', label: 'Image' },
  speech: { path: '/v1/audio/speech', proxyPath: '/v1/audio/speech', label: 'Speech' },
  transcribe: { path: '/v1/audio/transcriptions', proxyPath: '/v1/audio/transcriptions', label: 'Transcribe' },
  embed: { path: '/v1/embeddings', proxyPath: '/v1/embeddings', label: 'Embed' },
  music: { path: '/v1/music/generations', proxyPath: '/v1/music/generations', label: 'Music' },
  // Generic passthrough: the route id is a path param, not a body field. Callers
  // (code-samples, route-tester) substitute the actual route id into the path.
  generic: { path: '/v1/generic/{routeId}', proxyPath: '/v1/generic/{routeId}', label: 'Generic' },
};

export function modalityEndpoint(modality?: string): ModalityEndpoint {
  return MAP[modality ?? 'chat'] ?? MAP.chat!;
}
