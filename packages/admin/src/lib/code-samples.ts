/**
 * Generate ready-to-copy client code snippets for a given route.
 *
 * Mirrors Postman's "Code" tab: pick a language, get a runnable sample that
 * calls the gateway with the route id as `model`. The base URL and API key are
 * templated so the user fills them in (key never leaves their machine).
 */

export interface SampleContext {
  /** Client-facing route id (this becomes the `model` field). */
  routeId: string;
  /** Gateway origin, e.g. "http://localhost:8787". */
  baseUrl: string;
  /** Placeholder client key. */
  apiKey: string;
  /** Optional prompt for the sample message. */
  prompt?: string;
}

export type Language = 'curl' | 'node' | 'python' | 'php' | 'go' | 'stream';

const BODY = (ctx: SampleContext) =>
  JSON.stringify(
    {
      model: ctx.routeId,
      messages: [{ role: 'user', content: ctx.prompt || 'Hello!' }],
      stream: false,
    },
    null,
    2,
  ).replace(/\n/g, '\n  ');

const SAMPLES: Record<Language, (ctx: SampleContext) => string> = {
  curl: (c) => `curl ${c.baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${c.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
  ${BODY(c).slice(2)}
}'`,

  node: (c) => `// npm i openai
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${c.baseUrl}/v1",
  apiKey: "${c.apiKey}",          // your sg_live_* key
});

const res = await client.chat.completions.create({
  model: "${c.routeId}",          // route id, not a vendor model
  messages: [{ role: "user", content: "${c.prompt || 'Hello!'}" }],
});
console.log(res.choices[0].message.content);`,

  python: (c) => `# pip install openai
from openai import OpenAI

client = OpenAI(
    base_url="${c.baseUrl}/v1",
    api_key="${c.apiKey}",        # your sg_live_* key
)

res = client.chat.completions.create(
    model="${c.routeId}",         # route id, not a vendor model
    messages=[{"role": "user", "content": "${c.prompt || 'Hello!'}"}],
)
print(res.choices[0].message.content)`,

  php: (c) => `<?php
// uses ext-curl
$ch = curl_init("${c.baseUrl}/v1/chat/completions");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer ${c.apiKey}",
        "Content-Type: application/json",
    ],
    CURLOPT_POSTFIELDS => json_encode([
        "model" => "${c.routeId}",   // route id
        "messages" => [["role" => "user", "content" => "${c.prompt || 'Hello!'}"]],
    ]),
]);
echo json_decode(curl_exec($ch), true)["choices"][0]["message"]["content"];`,

  go: (c) => `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

func main() {
	body, _ := json.Marshal(map[string]any{
		"model": "${c.routeId}",
		"messages": []map[string]string{
			{"role": "user", "content": "${c.prompt || 'Hello!'}"},
		},
	})
	req, _ := http.NewRequest("POST", "${c.baseUrl}/v1/chat/completions", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer ${c.apiKey}")
	req.Header.Set("Content-Type", "application/json")
	res, _ := http.DefaultClient.Do(req)
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	fmt.Println(string(out))
}`,

  stream: (c) => `curl ${c.baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${c.apiKey}" \\
  -H "Content-Type: application/json" \\
  -N \\
  -d '{
  ${BODY(c).slice(2).replace('"stream": false', '"stream": true')}
}'`,
};

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

/** Detect the gateway base URL from the browser (the admin is same-origin proxy). */
export function detectBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:8787';
  return `${window.location.protocol}//${window.location.hostname}:8787`;
}
