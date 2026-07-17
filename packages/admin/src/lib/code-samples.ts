import { modalityEndpoint } from './modality-endpoints';

/**
 * Generate ready-to-copy client code snippets for a given route.
 *
 * Mirrors Postman's "Code" tab: pick a language, get a runnable sample that
 * calls the gateway with the route id as `model`. The base URL and API key are
 * templated so the user fills them in (key never leaves their machine).
 *
 * Modality-aware:
 *   - chat / image / speech / embed use the OpenAI SDK where one exists
 *     (Node, Python) and raw HTTP elsewhere (PHP, Go, cURL).
 *   - music and transcribe are NOT part of the OpenAI API surface, so every
 *     language uses raw HTTP (fetch / requests / curl / …). Transcribe also
 *     requires multipart/form-data with a `file` field.
 *
 * Streaming is chat-only (the only modality that supports SSE), so the caller
 * hides the "cURL (stream)" tab for any non-chat route.
 */

export interface SampleContext {
  routeId: string;
  modality?: string;
  baseUrl: string;
  apiKey: string;
  prompt?: string;
}

export type Language = 'curl' | 'node' | 'python' | 'php' | 'go' | 'stream';

/** Sensible default prompt per modality. */
function defaultPrompt(modality?: string): string {
  switch (modality) {
    case 'image':
      return 'A cat in a spacesuit, cinematic lighting';
    case 'music':
      return 'Lo-fi hip-hop with warm Rhodes piano, 90 BPM';
    case 'speech':
      return 'Hello! Welcome to SiberGate.';
    case 'embed':
      return 'SiberGate is a self-hosted AI gateway.';
    case 'transcribe':
      return ''; // transcribe sends a file, not a prompt
    case 'generic':
      return ''; // generic REST: body is arbitrary JSON, see genericBody()
    case 'chat':
    default:
      return 'Hello!';
  }
}

/**
 * Resolve the gateway path for a context, substituting the route id into path
 * templates that use `{routeId}` (the generic passthrough path). Other
 * modalities have static paths.
 */
function resolvePath(ctx: SampleContext): string {
  const ep = modalityEndpoint(ctx.modality);
  return ep.path.replace('{routeId}', ctx.routeId);
}

/** Example JSON body for the generic passthrough modality (arbitrary). */
function genericBody(ctx: SampleContext): string {
  return JSON.stringify(ctx.prompt ? JSON.parse(ctx.prompt) : { example: 'payload' }, null, 2);
}

/* ───────────────────────── shared body builders ────────────────────────── */

/** JSON request body for JSON-based modalities (chat, image, speech, embed, music). */
function bodyForModality(ctx: SampleContext): string {
  const prompt = ctx.prompt || defaultPrompt(ctx.modality);
  switch (ctx.modality) {
    case 'image':
      return JSON.stringify({ model: ctx.routeId, prompt, n: 1, size: '1024x1024' }, null, 2);
    case 'speech':
      return JSON.stringify({ model: ctx.routeId, input: prompt, voice: 'alloy' }, null, 2);
    case 'embed':
      return JSON.stringify({ model: ctx.routeId, input: prompt }, null, 2);
    case 'music':
      return JSON.stringify({ model: ctx.routeId, prompt, duration: 30 }, null, 2);
    case 'chat':
    default:
      return JSON.stringify(
        { model: ctx.routeId, messages: [{ role: 'user', content: prompt }], stream: false },
        null,
        2,
      );
  }
}

/** Stream variant body (chat only). */
function bodyStream(ctx: SampleContext): string {
  const prompt = ctx.prompt || defaultPrompt('chat');
  return JSON.stringify(
    { model: ctx.routeId, messages: [{ role: 'user', content: prompt }], stream: true },
    null,
    2,
  );
}

/* ───────────────────────────── per language ────────────────────────────── */

const SAMPLES: Record<Language, (ctx: SampleContext) => string> = {
  /* ───────────────────────────── cURL ───────────────────────────── */
  curl: (c) => {
    // Transcribe: multipart upload of an audio file.
    if (c.modality === 'transcribe') {
      const ep = modalityEndpoint(c.modality);
      return `curl ${c.baseUrl}${ep.path} \\
  -H "Authorization: Bearer ${c.apiKey}" \\
  -F "model=${c.routeId}" \\
  -F "file=@audio.mp3"`;
    }

    // Generic: passthrough to /v1/proxy/<routeId> (any method/body).
    if (c.modality === 'generic') {
      const path = resolvePath(c);
      return `curl -X POST ${c.baseUrl}${path} \\
  -H "Authorization: Bearer ${c.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ example: 'payload' })}'`;
    }

    // Everything else: JSON body.
    const ep = modalityEndpoint(c.modality);
    const body = bodyForModality(c).replace(/\n/g, '\n  ');
    return `curl ${c.baseUrl}${ep.path} \\
  -H "Authorization: Bearer ${c.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
  ${body.slice(2)}
}'`;
  },

  /* ─────────────────────────── Node.js ─────────────────────────── */
  node: (c) => {
    // Modalities covered by the OpenAI SDK use it; the rest use fetch.
    if (c.modality === 'image') {
      return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${c.baseUrl}/v1",
  apiKey: "${c.apiKey}",
});

const res = await client.images.generate({
  model: "${c.routeId}",
  prompt: "${c.prompt || defaultPrompt('image')}",
  n: 1,
  size: "1024x1024",
});
console.log(res.data[0].url);`;
    }
    if (c.modality === 'speech') {
      return `import OpenAI from "openai";
import { writeFileSync } from "node:fs";

const client = new OpenAI({
  baseURL: "${c.baseUrl}/v1",
  apiKey: "${c.apiKey}",
});

const audio = await client.audio.speech.create({
  model: "${c.routeId}",
  input: "${c.prompt || defaultPrompt('speech')}",
  voice: "alloy",
});
writeFileSync("output.mp3", Buffer.from(await audio.arrayBuffer()));`;
    }
    if (c.modality === 'embed') {
      return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${c.baseUrl}/v1",
  apiKey: "${c.apiKey}",
});

const res = await client.embeddings.create({
  model: "${c.routeId}",
  input: "${c.prompt || defaultPrompt('embed')}",
});
console.log(res.data[0].embedding.slice(0, 5));`;
    }
    if (c.modality === 'chat') {
      return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${c.baseUrl}/v1",
  apiKey: "${c.apiKey}",
});

const res = await client.chat.completions.create({
  model: "${c.routeId}",
  messages: [{ role: "user", content: "${c.prompt || defaultPrompt('chat')}" }],
});
console.log(res.choices[0].message.content);`;
    }

    // Generic passthrough: not an OpenAI endpoint → raw fetch with any method/body.
    if (c.modality === 'generic') {
      const path = resolvePath(c);
      return `// /v1/proxy/${c.routeId} is a SiberGate passthrough — forward any method + body.
const res = await fetch("${c.baseUrl}${path}", {
  method: "POST",
  headers: {
    Authorization: "Bearer ${c.apiKey}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ example: "payload" }),
});
console.log(res.status, await res.text());`;
    }

    // music + transcribe: NOT OpenAI API → raw fetch.
    const ep = modalityEndpoint(c.modality);
    if (c.modality === 'transcribe') {
      return `import { readFileSync } from "node:fs";

const fileBytes = readFileSync("audio.mp3");

const res = await fetch("${c.baseUrl}${ep.path}", {
  method: "POST",
  headers: { Authorization: "Bearer ${c.apiKey}" },
  // Let fetch set the multipart boundary — don't set Content-Type manually.
  body: (() => {
    const form = new FormData();
    form.append("model", "${c.routeId}");
    form.append("file", new Blob([fileBytes]), "audio.mp3");
    return form;
  })(),
});
const { text } = await res.json();
console.log(text);`;
    }
    // music
    const body = bodyForModality(c);
    return `// /v1/music/generations is a SiberGate extension — no SDK, use fetch.
const res = await fetch("${c.baseUrl}${ep.path}", {
  method: "POST",
  headers: {
    Authorization: "Bearer ${c.apiKey}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(${body}),
});
const { audio } = await res.json(); // data-uri or URL
console.log(audio);`;
  },

  /* ──────────────────────────── Python ─────────────────────────── */
  python: (c) => {
    if (c.modality === 'image') {
      return `from openai import OpenAI

client = OpenAI(base_url="${c.baseUrl}/v1", api_key="${c.apiKey}")

res = client.images.generate(
    model="${c.routeId}",
    prompt="${c.prompt || defaultPrompt('image')}",
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
    input="${c.prompt || defaultPrompt('speech')}",
    voice="alloy",
)
audio.write_to_file("output.mp3")`;
    }
    if (c.modality === 'embed') {
      return `from openai import OpenAI

client = OpenAI(base_url="${c.baseUrl}/v1", api_key="${c.apiKey}")

res = client.embeddings.create(
    model="${c.routeId}",
    input="${c.prompt || defaultPrompt('embed')}",
)
print(res.data[0].embedding[:5])`;
    }
    if (c.modality === 'chat') {
      return `from openai import OpenAI

client = OpenAI(base_url="${c.baseUrl}/v1", api_key="${c.apiKey}")

res = client.chat.completions.create(
    model="${c.routeId}",
    messages=[{"role": "user", "content": "${c.prompt || defaultPrompt('chat')}"}],
)
print(res.choices[0].message.content)`;
    }

    // Generic passthrough: not an OpenAI endpoint → raw requests with any method/body.
    if (c.modality === 'generic') {
      const path = resolvePath(c);
      return `# /v1/proxy/${c.routeId} is a SiberGate passthrough — forward any method + body.
import requests

res = requests.post(
    "${c.baseUrl}${path}",
    headers={
        "Authorization": "Bearer ${c.apiKey}",
        "Content-Type": "application/json",
    },
    json={"example": "payload"},
)
print(res.status_code, res.text)`;
    }

    // music + transcribe: raw HTTP via requests.
    const ep = modalityEndpoint(c.modality);
    if (c.modality === 'transcribe') {
      return `import requests

res = requests.post(
    "${c.baseUrl}${ep.path}",
    headers={"Authorization": "Bearer ${c.apiKey}"},
    data={"model": "${c.routeId}"},
    files={"file": open("audio.mp3", "rb")},
)
print(res.json()["text"])`;
    }
    // music
    const body = bodyForModality(c);
    return `# /v1/music/generations is a SiberGate extension — no SDK, use requests.
import json, requests

res = requests.post(
    "${c.baseUrl}${ep.path}",
    headers={
        "Authorization": "Bearer ${c.apiKey}",
        "Content-Type": "application/json",
    },
    data=json.dumps(${body}),
)
print(res.json()["audio"])  # data-uri or URL`;
  },

  /* ────────────────────────────── PHP ──────────────────────────── */
  php: (c) => {
    // Transcribe: multipart upload.
    if (c.modality === 'transcribe') {
      const ep = modalityEndpoint(c.modality);
      return `<?php
$ch = curl_init("${c.baseUrl}${ep.path}");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ["Authorization: Bearer ${c.apiKey}"],
    CURLOPT_POSTFIELDS => [
        "model" => "${c.routeId}",
        "file" => new CURLFile("audio.mp3"),
    ],
]);
echo curl_exec($ch);`;
    }

    // Generic passthrough: /v1/proxy/<routeId>, any method/body.
    if (c.modality === 'generic') {
      const path = resolvePath(c);
      return `<?php
// /v1/proxy/${c.routeId} is a SiberGate passthrough — forward any method + body.
$ch = curl_init("${c.baseUrl}${path}");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CUSTOMREQUEST => "POST",
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer ${c.apiKey}",
        "Content-Type: application/json",
    ],
    CURLOPT_POSTFIELDS => json_encode(["example" => "payload"]),
]);
echo curl_exec($ch);`;
    }

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

  /* ─────────────────────────────── Go ──────────────────────────── */
  go: (c) => {
    // Transcribe: multipart writer.
    if (c.modality === 'transcribe') {
      const ep = modalityEndpoint(c.modality);
      return `package main

import (
\t"bytes"
\t"fmt"
\t"io"
\t"mime/multipart"
\t"net/http"
\t"os"
)

func main() {
\tvar buf bytes.Buffer
\tw := multipart.NewWriter(&buf)
\tw.WriteField("model", "${c.routeId}")
\tf, _ := os.Open("audio.mp3")
\tdefer f.Close()
\tpart, _ := w.CreateFormFile("file", "audio.mp3")
\tio.Copy(part, f)
\tw.Close()

\treq, _ := http.NewRequest("POST", "${c.baseUrl}${ep.path}", &buf)
\treq.Header.Set("Authorization", "Bearer ${c.apiKey}")
\treq.Header.Set("Content-Type", w.FormDataContentType())
\tres, _ := http.DefaultClient.Do(req)
\tdefer res.Body.Close()
\tout, _ := io.ReadAll(res.Body)
\tfmt.Println(string(out))
}`;
    }

    // Generic passthrough: /v1/proxy/<routeId>, any method/body.
    if (c.modality === 'generic') {
      const path = resolvePath(c);
      return `package main

// /v1/proxy/${c.routeId} is a SiberGate passthrough — forward any method + body.
import (
\t"bytes"
\t"fmt"
\t"io"
\t"net/http"
)

func main() {
\tbody := []byte(\`{"example":"payload"}\`)
\treq, _ := http.NewRequest("POST", "${c.baseUrl}${path}", bytes.NewReader(body))
\treq.Header.Set("Authorization", "Bearer ${c.apiKey}")
\treq.Header.Set("Content-Type", "application/json")
\tres, _ := http.DefaultClient.Do(req)
\tdefer res.Body.Close()
\tout, _ := io.ReadAll(res.Body)
\tfmt.Println(res.StatusCode, string(out))
}`;
    }

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

  /* ─────────────────────── cURL (chat stream) ──────────────────── */
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

/** PHP map literal for the (JSON) body. */
function phpBody(c: SampleContext): string {
  const prompt = c.prompt || defaultPrompt(c.modality);
  switch (c.modality) {
    case 'image':
      return `["model" => "${c.routeId}", "prompt" => "${prompt}", "n" => 1, "size" => "1024x1024"]`;
    case 'speech':
      return `["model" => "${c.routeId}", "input" => "${prompt}", "voice" => "alloy"]`;
    case 'embed':
      return `["model" => "${c.routeId}", "input" => "${prompt}"]`;
    case 'music':
      return `["model" => "${c.routeId}", "prompt" => "${prompt}", "duration" => 30]`;
    default:
      return `["model" => "${c.routeId}", "messages" => [["role" => "user", "content" => "${prompt}"]]]`;
  }
}

/** Go map literal for the (JSON) body. */
function goBody(c: SampleContext): string {
  const prompt = c.prompt || defaultPrompt(c.modality);
  switch (c.modality) {
    case 'image':
      return `map[string]any{"model": "${c.routeId}", "prompt": "${prompt}", "n": 1, "size": "1024x1024"}`;
    case 'speech':
      return `map[string]any{"model": "${c.routeId}", "input": "${prompt}", "voice": "alloy"}`;
    case 'embed':
      return `map[string]any{"model": "${c.routeId}", "input": "${prompt}"}`;
    case 'music':
      return `map[string]any{"model": "${c.routeId}", "prompt": "${prompt}", "duration": 30}`;
    default:
      return `map[string]any{"model": "${c.routeId}", "messages": []map[string]string{{"role": "user", "content": "${prompt}"}}}`;
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

/** Languages relevant for a modality (stream is chat-only). */
export function languagesForModality(modality?: string): Array<{ id: Language; label: string }> {
  if (modality === 'chat') return LANGUAGES;
  return LANGUAGES.filter((l) => l.id !== 'stream');
}

export function generateSample(lang: Language, ctx: SampleContext): string {
  return SAMPLES[lang](ctx);
}

/** Detect the gateway base URL from the browser. */
export function detectBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:8787';
  return `${window.location.protocol}//${window.location.hostname}:8787`;
}

/** Default sample prompt for a modality (for dialog seed value). */
export function defaultPromptFor(modality?: string): string {
  return defaultPrompt(modality);
}
