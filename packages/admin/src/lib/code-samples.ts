import { modalityEndpoint } from './modality-endpoints';

/**
 * Generate ready-to-copy client code snippets for a given route.
 *
 * Mirrors Postman's "Code" tab: pick a language, get a runnable sample that
 * calls the gateway with the route id as `model`. The base URL and API key are
 * templated so the user fills them in (key never leaves their machine).
 *
 * Now modality-aware: image routes generate image samples, speech routes
 * generate speech samples, etc. — not just chat.
 */

export interface SampleContext {
  routeId: string;
  modality?: string;
  baseUrl: string;
  apiKey: string;
  prompt?: string;
}

export type Language = 'curl' | 'node' | 'python' | 'php' | 'go' | 'stream';

/** Build the request body JSON for the modality. */
function bodyForModality(ctx: SampleContext): string {
  const prompt = ctx.prompt || 'Hello!';
  switch (ctx.modality) {
    case 'image':
      return JSON.stringify({ model: ctx.routeId, prompt, n: 1, size: '1024x1024' }, null, 2);
    case 'speech':
      return JSON.stringify({ model: ctx.routeId, input: prompt, voice: 'alloy' }, null, 2);
    case 'embed':
      return JSON.stringify({ model: ctx.routeId, input: prompt }, null, 2);
    case 'music':
      return JSON.stringify({ model: ctx.routeId, prompt }, null, 2);
    case 'chat':
    default:
      return JSON.stringify(
        { model: ctx.routeId, messages: [{ role: 'user', content: prompt }], stream: false },
        null,
        2,
      );
  }
}

/** Build the stream variant body (chat only). */
function bodyStream(ctx: SampleContext): string {
  const prompt = ctx.prompt || 'Hello!';
  return JSON.stringify(
    { model: ctx.routeId, messages: [{ role: 'user', content: prompt }], stream: true },
    null,
    2,
  );
}

const SAMPLES: Record<Language, (ctx: SampleContext) => string> = {
  curl: (c) => {
    const ep = modalityEndpoint(c.modality);
    const body = bodyForModality(c).replace(/\n/g, '\n  ');
    return `curl ${c.baseUrl}${ep.path} \\
  -H "Authorization: Bearer ${c.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
  ${body.slice(2)}
}'`;
  },

  node: (c) => {
    const ep = modalityEndpoint(c.modality);
    if (c.modality === 'image') {
      return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${c.baseUrl}/v1",
  apiKey: "${c.apiKey}",
});

const res = await client.images.generate({
  model: "${c.routeId}",
  prompt: "${c.prompt || 'A cat in a spacesuit'}",
  n: 1,
  size: "1024x1024",
});
console.log(res.data[0].url);`;
    }
    if (c.modality === 'speech') {
      return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${c.baseUrl}/v1",
  apiKey: "${c.apiKey}",
});

const audio = await client.audio.speech.create({
  model: "${c.routeId}",
  input: "${c.prompt || 'Hello!'}",
  voice: "alloy",
});
// audio is a Blob — save or play it
const buf = Buffer.from(await audio.arrayBuffer());
require("fs").writeFileSync("output.mp3", buf);`;
    }
    if (c.modality === 'embed') {
      return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${c.baseUrl}/v1",
  apiKey: "${c.apiKey}",
});

const res = await client.embeddings.create({
  model: "${c.routeId}",
  input: "${c.prompt || 'Hello!'}",
});
console.log(res.data[0].embedding.slice(0, 5));`;
    }
    // chat (default) + music
    return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${c.baseUrl}/v1",
  apiKey: "${c.apiKey}",
});

const res = await client.chat.completions.create({
  model: "${c.routeId}",
  messages: [{ role: "user", content: "${c.prompt || 'Hello!'}" }],
});
console.log(res.choices[0].message.content);`;
  },

  python: (c) => {
    if (c.modality === 'image') {
      return `from openai import OpenAI

client = OpenAI(base_url="${c.baseUrl}/v1", api_key="${c.apiKey}")

res = client.images.generate(
    model="${c.routeId}",
    prompt="${c.prompt || 'A cat in a spacesuit'}",
    n=1,
    size="1024x1024",
)
print(res.data[0].url)`;
    }
    if (c.modality === 'speech') {
      return `from openai import OpenAI

client = OpenAI(base_url="${c.baseUrl}/v1", api_key="${c.apiKey}")

audio = client.audio.speech.create(
    model="${c.routeId}",
    input="${c.prompt || 'Hello!'}",
    voice="alloy",
)
audio.write_to_file("output.mp3")`;
    }
    if (c.modality === 'embed') {
      return `from openai import OpenAI

client = OpenAI(base_url="${c.baseUrl}/v1", api_key="${c.apiKey}")

res = client.embeddings.create(
    model="${c.routeId}",
    input="${c.prompt || 'Hello!'}",
)
print(res.data[0].embedding[:5])`;
    }
    return `from openai import OpenAI

client = OpenAI(base_url="${c.baseUrl}/v1", api_key="${c.apiKey}")

res = client.chat.completions.create(
    model="${c.routeId}",
    messages=[{"role": "user", "content": "${c.prompt || 'Hello!'}"}],
)
print(res.choices[0].message.content)`;
  },

  php: (c) => {
    const ep = modalityEndpoint(c.modality);
    return `<?php
$ch = curl_init("${c.baseUrl}${ep.path}");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer ${c.apiKey}",
        "Content-Type: application/json",
    ],
    CURLOPT_POSTFIELDS => json_encode(${phpBody(c)}),
]);
echo curl_exec($ch);`;
  },

  go: (c) => {
    const ep = modalityEndpoint(c.modality);
    return `package main

import (
\t"bytes"
\t"encoding/json"
\t"fmt"
\t"io"
\t"net/http"
)

func main() {
\tbody, _ := json.Marshal(${goBody(c)})
\treq, _ := http.NewRequest("POST", "${c.baseUrl}${ep.path}", bytes.NewReader(body))
\treq.Header.Set("Authorization", "Bearer ${c.apiKey}")
\treq.Header.Set("Content-Type", "application/json")
\tres, _ := http.DefaultClient.Do(req)
\tdefer res.Body.Close()
\tout, _ := io.ReadAll(res.Body)
\tfmt.Println(string(out))
}`;
  },

  stream: (c) => {
    const ep = modalityEndpoint(c.modality);
    const body = bodyStream(c).replace(/\n/g, '\n  ');
    return `curl ${c.baseUrl}${ep.path} \\
  -H "Authorization: Bearer ${c.apiKey}" \\
  -H "Content-Type: application/json" \\
  -N \\
  -d '{
  ${body.slice(2)}
}'`;
  },
};

/** PHP map literal for the body. */
function phpBody(c: SampleContext): string {
  switch (c.modality) {
    case 'image':
      return `["model" => "${c.routeId}", "prompt" => "${c.prompt || 'Hello!'}", "n" => 1]`;
    case 'speech':
      return `["model" => "${c.routeId}", "input" => "${c.prompt || 'Hello!'}", "voice" => "alloy"]`;
    case 'embed':
      return `["model" => "${c.routeId}", "input" => "${c.prompt || 'Hello!'}"]`;
    case 'music':
      return `["model" => "${c.routeId}", "prompt" => "${c.prompt || 'Hello!'}"]`;
    default:
      return `["model" => "${c.routeId}", "messages" => [["role" => "user", "content" => "${c.prompt || 'Hello!'}"]]]`;
  }
}

/** Go map literal for the body. */
function goBody(c: SampleContext): string {
  switch (c.modality) {
    case 'image':
      return `map[string]any{"model": "${c.routeId}", "prompt": "${c.prompt || 'Hello!'}", "n": 1}`;
    case 'speech':
      return `map[string]any{"model": "${c.routeId}", "input": "${c.prompt || 'Hello!'}", "voice": "alloy"}`;
    case 'embed':
      return `map[string]any{"model": "${c.routeId}", "input": "${c.prompt || 'Hello!'}"}`;
    case 'music':
      return `map[string]any{"model": "${c.routeId}", "prompt": "${c.prompt || 'Hello!'}"}`;
    default:
      return `map[string]any{"model": "${c.routeId}", "messages": []map[string]string{{"role": "user", "content": "${c.prompt || 'Hello!'}"}}}`;
  }
}

export const LANGUAGES: Array<{ id: Language; label: string }> = [
  { id: 'curl', label: 'cURL' },
  { id: 'node', label: 'Node.js' },
  { id: 'python', label: 'Python' },
  { id: 'php', label: 'PHP' },
  { id: 'go', label: 'Go' },
  { id: 'stream', label: 'cURL (stream)' },
];

export function generateSample(lang: Language, ctx: SampleContext): string {
  return SAMPLES[lang](ctx);
}

/** Detect the gateway base URL from the browser. */
export function detectBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:8787';
  return `${window.location.protocol}//${window.location.hostname}:8787`;
}
