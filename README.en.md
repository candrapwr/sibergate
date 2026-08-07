<div align="center">

# 🚪 SiberGate

**The self-hosted AI gateway that routes intelligently across every provider.**

One OpenAI-compatible endpoint. Six AI modalities plus a generic REST passthrough.
Smart fallback, fastest-pick, and load balancing — all on your own infrastructure,
with zero markup.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![Providers](https://img.shields.io/badge/providers-18-orange.svg)](#-built-in-catalog)
[![Models](https://img.shields.io/badge/models-206-orange.svg)](#-built-in-catalog)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#-contributing)

</div>

---

> 📖 **[Baca dalam Bahasa Indonesia](./README.md)** · 🌐 **Part of the [Siber Ecosystem](https://datasiber.com)** — built & maintained by **DataSiberLab**.

SiberGate is a privacy-first, open-source **reverse proxy** that sits in front of
your LLM, image, audio, and embedding providers. Instead of hard-coding one
vendor into every app, you point your clients at SiberGate and let it handle the
hard parts: routing, failover, load balancing, cost tracking, and credential
management — all through a clean admin dashboard.

```bash
# Point any OpenAI SDK client at SiberGate — that's it.
const client = new OpenAI({ baseURL: "http://localhost:8787/v1", apiKey: "sg_live_..." });
await client.chat.completions.create({ model: "smart", messages: [...] });
```

<p align="center">
  <img src="images/dashboard.png" alt="SiberGate Admin Dashboard" width="100%" />
</p>

---

## ✨ Why SiberGate?

| | OpenRouter / SaaS gateways | **SiberGate** |
|---|---|---|
| 🏠 **Where it runs** | Their cloud | **Your machine** |
| 🔑 **API keys** | They hold them | **You hold them** (AES-256-GCM encrypted) |
| 💰 **Cost** | + markup per token | **0 markup** — you pay providers directly |
| 🔒 **Privacy** | Data flows through them | **Data never leaves your infra** |
| 🎛️ **Control** | Their UI, their limits | **Full control** — self-host, your rules |
| 🚀 **Setup** | Signup + credits | `npm run seed && npm start` |

### 🎯 Key features

- **🔌 One endpoint, all providers** — OpenAI, DeepSeek, Anthropic, Gemini, Groq, Mistral, and 10+ more, unified behind the OpenAI API you already use.
- **🧠 Smart routing** — `fallback` (auto-failover), `fastest` (lowest-latency pick), `weighted` (load balancing). Strategies apply to every modality.
- **🎨 Six AI modalities + REST passthrough** — chat, image generation, text-to-speech, transcription, embeddings, and **text-to-music** (DeepInfra ACE-Step), plus a **generic** modality that proxies any non-LLM API (GET/POST/PUT/DELETE) with the same routing + failover.
- **🔑 Multiple API keys per provider** — one provider may own **several keys** (e.g. multiple OpenAI/Gemini accounts), each with a label. Every route target points to a specific key (`provider → model → key`) — handy for cross-account load balancing or quota isolation. One key is marked **default** (used when a target doesn't specify one). Stats are tracked **per upstream key**.
- **🔑 Automatic Gemini `thought_signature` preservation** — multi-turn tool/function calling on Gemini 3.x requires a special signature on every turn. SiberGate auto-captures the signature from the response, strips it from the client payload (pure OpenAI format), and injects it back when a multi-turn request arrives — **transparent, no client code changes**. See [Gemini-specific compatibility](#-gemini-specific-compatibility).
- **🔀 Cross-vendor tool calling without errors** — agentic loops with failover between models of different vendors (e.g. Gemini ↔ DeepSeek) normally crash in multi-turn because each vendor has its own mandatory internal token (Gemini `thought_signature`, DeepSeek `reasoning_content`) that is incompatible and must be round-tripped. SiberGate solves it: set the Gemini target's modality to `tools-text` → the gateway converts `tool_calls` + role `tool` to universal XML text up front, then re-parses back to OpenAI format at the end. The client keeps clean original `tool_calls`, no vendor-specific signature leaks, no `400 missing signature` errors. See [Cross-vendor tool calling](#-cross-vendor-tool-calling).
- **🧠 Cross-vendor reasoning/thinking mapping** — every provider controls "thinking" differently (OpenAI `reasoning_effort`, Anthropic `thinking`+`effort`, Gemini `thinkingConfig`, OpenRouter `reasoning.effort`). The client sends **one canonical shape** (`reasoning_effort: none|minimal|low|medium|high|xhigh`) and the gateway auto-translates it to the target provider's native format. Cross-vendor failover stays correct (each target is mapped independently). See [Reasoning/thinking mapping](#-reasoningthinking-mapping).
- **🪄 Tool calling via text/XML (`tools-text`)** — a parallel modality that bypasses native function calling, with strong reasons: (1) **partial chunking** of arguments token-by-token (typing UX, vs Gemini's atomic native); (2) **dodge provider quirks** — no `thought_signature`, no `extra_content`, no wrong `finish_reason` on Gemini; (3) **~50% token savings** (input −49%, output −33%, since compact tool list vs heavy JSON schema); (4) **enables tool calling on models/providers that previously didn't support it** — as long as a model can chat + follow instructions, it can "call tools" via the XML pattern. The gateway injects a system prompt pattern `<tool_call><name>..</name><args>..</args></tool_call>`, streams the text, and re-parses it to OpenAI format. Opt-in per route target. See [Tool calling via text/XML](#-tool-calling-via-textxml-tools-text).
- **🌐 A gateway for plain APIs too** — via `/v1/generic/:routeId/*`, SiberGate doubles as a reverse proxy for REST APIs, webhooks, or internal microservices — with the same key vault, failover, and logging.
- **🛡️ Seamless failover** — a provider goes down? SiberGate silently moves to the next. Your client never notices.
- **⏱️ Per-target timeout** — `route.timeoutMs` applies to **each failover target**, not divided. A 30s route with 4 targets gives each target the full 30s. Failover is real: a slow target no longer eats into the next one's budget.
- **🛡️ HTML error page protection** — when an upstream (via Cloudflare/CDN/proxy) replies with an HTML error page (5xx status, or even a `200 OK` interstitial), SiberGate catches it at the source and returns a clean OpenAI-compat JSON error to the client — **no raw HTML leaks through**. Failover still kicks in; the HTML body is kept in the logs for debugging.
- **🖥️ Real-time Console** — a "Console" panel shows **every gateway event** live via SSE streaming: incoming requests, per-target failover, auth failures, config changes, system errors — all under 1s, not polled. In-memory ring buffer (cleared on restart), no SQLite duplication.
- **🔐 Centralized key vault** — clients only ever see a `sg_live_*` key. Real provider keys (default and additional) are encrypted at rest (AES-256-GCM), decrypted transiently at request time, and never logged. Plaintext is never returned by the API — only the label + a redacted prefix.
- **📊 Built-in observability** — per-request logs, token & cost tracking by route/provider/model/**upstream key**, live dashboard with charts. Every upstream error logs the **URL + response body** in full (key redacted) so it's easy to diagnose. When an upstream error occurs (including recovered failovers), a **full raw request** (client URL, redacted headers, body, upstream call) is auto-saved to a per-request file in `request_traces/` — not the DB, so the DB stays lean. In the Logs drawer, click **"View raw request"** to open a modal with the original request + the failing upstream response.
- **🖥️ Admin dashboard** — full CRUD for providers, models, routes, and keys; a chat & media playground; Postman-style code snippets in 6 languages.
- **🧩 Custom Scripts (build-your-own provider)** — write a Node.js script in the dashboard and its `console.log` output automatically becomes an HTTP endpoint (`/api/custom/<name>`) that flows through SiberGate's routing/failover exactly like any other provider. One provider can serve many scripts. Wrap legacy APIs, scrapers, or internal microservices into OpenAI-compatible providers without touching gateway code. See [Custom Scripts](#-custom-scripts-build-your-own-provider).
- **🌐 Proxy Layer (selective outbound proxy)** — route requests of **specific providers** through HTTP/HTTPS/SOCKS5/SOCKS4 proxy pools. Selective per-provider (not a global VPN): choose which providers go through a proxy. Pool = a set of proxies with weight + automatic health-check (active ping + passive on-fail) + failover. Test a proxy → see latency + exit IP + 🇺🇸 country (MaxMind GeoIP). Great for geo-block bypass (Gemini/OpenAI region-locked) & IP rotation. Dedicated proxy logging + Console live stream. See [Proxy Layer](#-proxy-layer).
- **💾 SQLite, zero ops** — one file, no database server to run. Master data, logs, and credentials all in one portable DB.
- **🔮 Future-proof** — JSON modalities mean adding new capabilities (video, code execution) is a data change, not a refactor.

---

## 🚀 Quickstart

### Prerequisites
- [Node.js](https://nodejs.org) ≥ 20 (or [Bun](https://bun.sh))
- That's it. SQLite is bundled; no Postgres/Redis needed.

### 1. Install
```bash
git clone <repo-url> sibergate && cd sibergate
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Add at least one provider key, e.g. OPENAI_API_KEY=sk-...
# Optionally set SIBERGATE_ADMIN_KEY to pin the admin token
```

### 3. Seed & run
```bash
npm run seed     # encrypts keys into SQLite, prints a client API key
npm run dev      # gateway :8787 + admin dashboard :3000 (hot-reload, for development)
```

> **Production / self-host** — build once, then run both services together:
> ```bash
> npm run build    # build core + gateway + admin
> npm start        # gateway :8787 + admin :3000 (production mode, no hot-reload)
> ```
> See also the [Deployment (PM2)](#-deployment-pm2) section below for auto-restart & boot-on-reboot.

**Ports are configurable.** The gateway reads `SIBERGATE_PORT` from `.env`; the
admin reads `SIBERGATE_ADMIN_PORT` from `packages/admin/.env.local` (default
`3000`). Example: to run the admin on `8010`, add `SIBERGATE_ADMIN_PORT=8010`
to `packages/admin/.env.local` and restart.

### 4. Try it
```bash
# Chat via the gateway
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer sg_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"smart","messages":[{"role":"user","content":"Hello!"}]}'

# Generate an image
curl http://localhost:8787/v1/images/generations \
  -H "Authorization: Bearer sg_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"image-fast","prompt":"a cat in a spacesuit"}'
```

Or open **http://localhost:3000** (or whatever `SIBERGATE_ADMIN_PORT` you set) for the admin dashboard.

---

## 🏗️ Architecture — two pillars

### 1. Master Data (SQLite — single source of truth)
- **Providers** — vendor endpoints + per-modality URL templates + **AES-256-GCM encrypted credentials**
- **Provider keys** — **multi-account**: a provider may own several upstream keys (each labeled + a redacted prefix); exactly one is marked **default** (used when a route target doesn't specify a key)
- **Models** — specs with **JSON modalities** (`text-to-text`, `vision`, `image-generation`, `audio`, `embeddings`, …) so adding new capability types is a data change, not a code change
- **API keys** — client keys (sha256-hashed; plaintext shown once at creation)

### 2. Routing Engine (operational)
- **Routes** — virtual client-facing endpoints (`smart`, `chat`, `image-fast`, …) tagged with a modality
- **Route targets** — ordered `(provider, model, weight, key)` mappings; filtered to providers that actually support the route's modality; the optional `key` points to a specific key on the provider (multi-account)
- **Strategies** — `fallback`, `fastest` (EMA latency), `weighted`
- **Per-target timeout** — `route.timeoutMs` applies **per failover target** in full (not divided). Each target gets its own `AbortController`, and client disconnects propagate to all targets. Failover actually moves to the next target instead of being an illusion.
- **Signature cache** — in-memory cache of Gemini `thought_signature` (per `tool_call.id`) for multi-turn tool calling; 1h TTL, 5000-entry cap, auto-evict
- **Requests** — per-request log (latency, tokens, cost, errors, served-by, **which upstream key served it**)

The polymorphic **provider adapter** dispatches each request to the right
modality handler (chat / image / speech / transcribe / embed / music / generic),
so one
gateway serves them all.

---

## 📦 Built-in catalog

SiberGate ships with a curated catalog of **18 providers** and **206 models** —
importable with one click (empty credentials; you set the keys afterward).
Coverage spans 6 modalities: text, vision, image-generation, audio (TTS/music),
audio-transcription, and embeddings.

| Provider | Modalities | Highlights |
|---|---|---|
| **OpenAI** | chat · vision · image · speech · transcribe · embed | GPT-5.6 (Sol/Terra/Luna), GPT-5.5, GPT-5.4 family, GPT-5, GPT-4.1, o3/o4, GPT Image 2, DALL·E, Realtime, TTS, Whisper, embeddings |
| **Anthropic** | chat · vision | Claude Fable 5, Opus 4.8 / 4.7 / 4.6 / 4.5, Sonnet 5 / 4.6 / 4.5, Haiku 4.5, 3.7 / 3.5 line |
| **Google Gemini** | chat · vision · audio · image · embed | Gemini 3.5 Flash, 3.1 Pro / Flash-Lite, 3 Flash, 2.5 Pro / Flash, Nano Banana 2 / Pro, Lyria 3 (music), Flash TTS, embeddings |
| **DeepSeek** | chat | DeepSeek V4 Flash / Pro, V3, R1 |
| **Groq** | chat · transcribe | GPT OSS 120B / 20B, Llama 4 Scout, 3.3 70B, Qwen3, DeepSeek R1 distill, Whisper v3 / Turbo |
| **xAI (Grok)** | chat · vision · image | Grok 4.5 / 4.3 / 4.20 Reasoning, Grok Build, Grok Imagine (image + video) |
| **Mistral** | chat · vision · embed · audio | Mistral Large 3 / Medium 3.5 / Small 4, Pixtral Large / 12B, OCR 4, Voxtral TTS, Embed |
| **OpenRouter** | chat · vision | Auto (cheapest), plus cross-vendor GPT-5.x / Claude / Gemini routing |
| **Together AI** | chat · vision · image | DeepSeek V4 Pro / Flash, Llama 4 / 3.3, Qwen 2.5 72B, FLUX.1 schnell / dev |
| **Fireworks AI** | chat · vision · image · transcribe | DeepSeek V4, GPT OSS 120B, Llama 4 Scout, Kimi K2.7, GLM 5.2, FLUX.1 dev, Whisper v3 |
| **Cohere** | chat · embed | Command A+ / A, R+ / R, Embed v3 (English + Multilingual) |
| **Perplexity** | chat | Sonar Pro, Sonar, Sonar Reasoning Pro |
| **Novita AI** | chat · image · embed | DeepSeek / Llama / Qwen via Novita + FLUX.1 / SDXL / SD 3.5 images |
| **DeepInfra** | chat · vision · image · music | ACE-Step text-to-music, FLUX.1, SD 3.5, Llama 4, DeepSeek R1 |
| **Z.AI (GLM)** | chat · vision · image · video · transcribe | GLM-5.2 / 5.1 / 5, GLM-4.7 / 4.6, GLM-V (vision), GLM-OCR, CogView-4, CogVideoX, Vidu (video), GLM-ASR |
| **Qwen Cloud** | chat · vision · audio · image · video · embed · transcribe | Qwen3.7-Max, Qwen3.6/3.5 series, Qwen-VL, Qwen-Omni (speech), Qwen Image 2.0, Wan 2.6 (video), CosyVoice TTS, embeddings |
| **Ollama** (local) | chat · vision · embed | Llama 3.3, Qwen 2.5, LLaVA, Nomic Embed |
| **vLLM** (local) | chat | Any HuggingFace model you serve |

_Settings → "Import catalog" → fill keys → done. Local providers (Ollama, vLLM)
need no key — just enable them._

---

## 🖥️ Admin Dashboard

A dark-themed dashboard (Next.js + shadcn/ui) at `http://localhost:3000`:

<p align="center">
  <img src="images/dashboard.png" alt="SiberGate Dashboard" width="100%" />
</p>

### Screenshots

<details>
<summary><b>📸 View all screens</b></summary>

| Screen | Preview |
|---|---|
| **Dashboard** — live stats, charts by route/provider/model | <img src="images/dashboard.png" width="600" alt="Dashboard" /> |
| **Usage** — token & cost monitoring, provider×model matrix | <img src="images/usage.png" width="600" alt="Usage" /> |
| **Providers** — CRUD with encrypted credentials | <img src="images/providers.png" width="600" alt="Providers" /> |
| **Models** — directory with modality badges & filters | <img src="images/models.png" width="600" alt="Models" /> |
| **Routes** — virtual endpoints, modality + target builder | <img src="images/routes.png" width="600" alt="Routes" /> |
| **API Keys** — issue & manage client keys | <img src="images/api_keys.png" width="600" alt="API Keys" /> |
| **Logs** — filterable request table + detail drawer | <img src="images/logs.png" width="600" alt="Logs" /> |
| **Console** — live event stream (request, routing, auth) | <img src="images/console.png" width="600" alt="Console" /> |
| **Chat Playground** — live SSE streaming test | <img src="images/chat_playGround.png" width="600" alt="Chat Playground" /> |
| **Media Lab** — image, speech & music generation | <img src="images/media_lab.png" width="600" alt="Media Lab" /> |
| **Settings** — import catalog & danger zone | <img src="images/settings.png" width="600" alt="Settings" /> |

</details>

### Features

- **Dashboard** — live stats (requests, success rate, tokens, spend) + charts by route/provider/model
- **Usage** — token & cost monitoring across providers, models, routes, **client API keys**, and **upstream keys**; provider×model matrix
- **Providers / Models / Routes / API Keys** — full CRUD with inline forms; route form filters models by selected modality. Providers have an **API keys** section (multi-account) — add/remove/set-default per key
- **Logs** — filterable request table + detail drawer; every upstream error shows a **URL + response body** panel in full, plus the failover trail (including which upstream key was used/failed)
- **Console** — **live event stream** in real time via SSE: incoming requests, per-target failover, auth failures, config changes, system errors. Terminal-style view with per-category filters, auto-scroll, expandable JSON details. Full per-request lifecycle: `incoming → upstream → routing (served/failed) → request (completed)`
- **Chat Playground** — test routes with live SSE streaming
- **Media Lab** — generate & preview images, speech, and music inline
- **Route testing** — probe any route and visualize the failover path
- **Settings → Maintenance** — clear logs, reset stats, and manually **clear the signature cache** (Gemini `thought_signature`)
- **Code snippets** — Postman-style client code in cURL / Node / Python / PHP / Go

The admin key is injected server-side via a proxy route — it never reaches the
browser. The playground uses a separate client key (`sg_live_*`).

---

## 🧩 Custom Scripts (build-your-own provider)

**Write a Node.js script, its `console.log` output becomes a provider.** SiberGate
executes the script via `child_process` and turns its stdout into the response
body of the `/api/custom/<script-name>` endpoint. That endpoint is then
registered as an ordinary HTTP provider (baseUrl → the gateway itself), so
**SiberGate's routing/failover flow is entirely unchanged** — purely additive.

Why is this useful? You can wrap ANYTHING into an OpenAI-compatible provider
without touching gateway code or rebuilding:

- **Legacy / internal APIs** — SOAP, internal GraphQL, backend microservices →
  a script wraps them into an OpenAI-shaped endpoint, instantly usable by routes.
- **Scrapers / aggregators** — pull data from non-API sources, reformat into
  chat/response JSON.
- **Custom business logic** — validation, transformation, or a mock provider
  for testing/development.
- **Non-LLM bridges** — webhook handlers, third-party REST, or any stateless
  function you want inside the same routing flow.

```
Client ──▶ Route ──▶ Engine ──▶ HTTP Adapter ──▶ Provider "my-script"
                                                    │ baseUrl: gateway itself
                                                    │ endpoint: /api/custom/{model}
                                                    ▼
                                          Gateway (loopback)
                                                    │ child_process spawn node
                                                    ▼
                                          script stdout = response body
```

### How to use

1. Open **Admin → Custom Scripts → New script**.
2. Write the script in the **code editor** (CodeMirror, with syntax highlighting
   and built-in templates: chat JSON, plain text, call external API). The
   `console.log` output is the response body.
3. Click **Test** to run it with a sample input — see stdout, stderr, exit code,
   and duration in real time.
4. Click **Register as provider** — a popup lets you:
   - Choose/edit the **Provider ID** and **provider display name**
   - Choose the **modality** (generic/chat/image/…)
   - **Reuse an existing provider** — one provider can serve many scripts
     (each script becomes a separate model with the `/api/custom/{model}`
     endpoint template)
5. Open **Routes** → add a target → pick the script's provider + model.

### Inputs available to a script

A script receives the request over two channels:

- **stdin** — the raw request body (string). Empty for bodyless requests (GET).
- **Env vars** — request metadata:
  - `SIBERGATE_REQUEST_METHOD` — HTTP method (`POST`, `GET`, …)
  - `SIBERGATE_REQUEST_PATH` — the request path
  - `SIBERGATE_REQUEST_QUERY` — query string (without the leading `?`)
  - `SIBERGATE_REQUEST_HEADERS` — JSON of headers (auth redacted)

### Security & isolation

- Execution via **`child_process`** — full isolation: a script crash, infinite
  loop, or OOM **does not affect the gateway process**.
- **Timeout** per script (default 10s, configurable 500ms–300000ms) → the
  script is force-killed (SIGKILL).
- **Buffer cap** of 5 MB each on stdout/stderr (prevents gateway OOM).
- **Client disconnect** (AbortSignal) immediately kills the running script.
- Sensitive headers (`Authorization`, `cookie`, `api-key`, …) are redacted
  before being passed to the script env.

> ⚠️ Scripts have **full Node capability** (`require`, `import`, `fetch`,
> file I/O, etc.). Suitable for self-hosted single-operator use. Do not expose
> the script editor to untrusted users without additional sandboxing.

### Example script (chat JSON)

```js
// Format an OpenAI chat/completions response — ready to be a 'chat' route target.
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const body = raw ? JSON.parse(raw) : {};
  const userMsg = body.messages?.at(-1)?.content ?? '';
  console.log(JSON.stringify({
    id: 'chat-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? 'custom',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: `Hi! You said: ${userMsg}` },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }));
});
```

### 🗺️ Performance roadmap

Execution currently uses **`child_process`** (spawn per request) for full
isolation and determinism. Node bootstrap overhead is ~30–50ms per call —
noticeable at high throughput. Planned:

- **Worker pool** (`worker_threads`) — reuse compiled modules, dropping overhead
  to ~3–5ms. Trade-off: state may leak between requests (workers are reused),
  so scripts must be stateless pure functions.
- **Native streaming** — emit SSE chunks line-by-line from `console.log`, so
  scripts can act as streaming LLM providers (not just REST).
- **Sandboxing** (`isolated-vm` / QuickJS) — advanced memory isolation for
  multi-tenant scenarios, at the cost of restricting `require`/`fetch`.

Optimization will be data-driven: wait until logs show spawn overhead
dominating (>40% of request time) before migrating away from `child_process`.

---

## 🌐 Proxy Layer

**Route requests of specific providers through an outbound proxy.** An isolated
proxy module (`packages/core/src/proxy/`) — when active, you **pick which
providers** have their requests flow through a proxy pool (selective
per-provider, **not a global VPN**).

Why is this useful?
- **Geo-block bypass** — Gemini/OpenAI/Anthropic are often region-locked. Route
  those providers through a US/EU proxy and requests go through.
- **IP rotation** — avoid per-IP rate limits. Multi-key + IP rotation is a
  powerful combination.
- **Corporate proxy** — gateway behind a firewall? Send all providers through
  the corporate proxy.

### What's supported

- **Protocols**: HTTP, HTTPS, SOCKS5, SOCKS4, SOCKS5h, SOCKS4a (via undici v7
  `ProxyAgent`; SOCKS5 is experimental in Node).
- **Pools**: a set of proxy URLs with `weight`. Strategy: `weighted`
  (random by weight, default), `round-robin` (cycle), `failover` (ordered).
- **Hybrid health-check**:
  - **Active**: background ping every 60s to a neutral endpoint → updates
    healthy + caches GeoIP (country/flag).
  - **Passive**: when a real request through a proxy fails (network/timeout),
    the member is automatically marked unhealthy and the next member is used.
  - Unhealthy members are skipped by the selector; they return to healthy once
    an active ping succeeds.
- **Test proxy**: a per-member Test button → measures latency + captures exit
  IP + looks up country → shows the 🇺🇸 flag (needs the GeoIP DB, see below).
- **Logging**: a dedicated `proxy_logs` table (query/filter separately at
  `/proxy/logs`) + Console live stream with a 🌐 flag when a request goes
  through a proxy.

### How to use

1. **Admin → Proxy Layer → New pool** — fill in id, name, strategy
   (weighted/round-robin/failover).
2. Add **members** with proxy URLs (`socks5://user:pass@host:1080`,
   `http://host:8080`, …) + weight + label. Click **Test** to check latency +
   country.
3. Open **Provider bindings** → tick which providers' requests should flow
   through this pool (selective — only the chosen providers).
4. Done. Requests to routes targeting those providers automatically go through
   the proxy. Watch events in **Proxy Logs** or the Console (filter `proxy`).

### Country detection (GeoIP)

Testing & health-checks auto-detect a proxy's country via the **MaxMind
GeoLite2-Country** mmdb. The file is downloaded on-demand:
- **Admin → Settings → GeoIP Database → Download/Update** (needs
  `SIBERGATE_MAXMIND_LICENSE_KEY` — free, register at maxmind.com).
- The file lives in `packages/core/data/` and is **git-ignored & excluded from
  backups** (not app data, re-downloadable).
- Without the GeoIP DB, proxies still work but the flag shows 🏳️ (unknown).

### Architecture

```
Client → Route → Engine → resolveProxy(providerId)
                          ↓ (provider bound to an active pool?)
                     selectMember (weight/health) → ProxyAgent
                          ↓
                   fetch(url, { dispatcher }) → via HTTP/SOCKS5 proxy
                          ↓
                 on fail → markMemberUnhealthy (passive) → failover
```

The proxy is injected at a single chokepoint (`sendUpstream` → `fetch`), so
every modality (chat/image/embed/music/…) gets proxying automatically with no
per-adapter code. Async image-polling uses the same proxy. **Zero behavioral
change** when no proxy is used (`dispatcher` undefined = direct fetch).

### Notes
- Proxy URLs with auth (`http://user:pass@host`) are supported natively and
  redacted in logs.
- `strictProxy` (planned): when true, a request fails hard if all members are
  unhealthy. Defaults to false → falls back to direct.
- Edge relay proxies (Vercel/Cloudflare/Deno, a URL-rewrite concept) = phase 2.

---

## 🔧 Gemini-specific compatibility

Google Gemini 3.x has a few quirks that SiberGate handles automatically so
clients can keep using the standard OpenAI format without modification:

### 1. Multi-turn tool/function calling (`thought_signature`)

When Gemini returns a tool call, it attaches a `thought_signature` (an internal
Google token for reasoning tracking). The signature **must be sent back** in the
assistant message on the next turn — if missing, Gemini replies
`400 Function call is missing a thought_signature`.

Since this field doesn't exist in the OpenAI format, SiberGate handles it
transparently:

1. **Capture** the signature from the Gemini response → cache it in memory (key: `tool_call.id`)
2. **Strip** `extra_content` from the response → the client receives pure OpenAI format
3. **Inject** the signature back into `body.messages` when a multi-turn request arrives → Gemini gets the full payload

**No client changes needed** — resend the assistant message in standard OpenAI format and the gateway inserts the signature automatically.

**Specific & low-overhead** — only Gemini providers (direct or via OpenRouter) are processed; other providers (DeepSeek, OpenAI, …) skip automatically. Cache: 1h TTL, 5000-entry cap, lazy eviction. Monitoring and manual clear live in **Settings → Maintenance → Signature cache**.

### 2. Model naming & deprecation

Older Gemini models (e.g. `gemini-2.5-flash-lite`) are deprecated by Google and reply `404 "no longer available to new users"`. The SiberGate catalog ships current models (`gemini-3.5-flash`, etc.); if your route still points to an old one, switch to a newer model on the Routes page.

---

## 🪄 Tool calling via text/XML (`tools-text`)

The `tools-text` modality is an alternative to native function calling with a different approach: the gateway strips OpenAI tool definitions, injects an XML-pattern system prompt, and lets the model do **text generation** (which streams token-by-token). The XML output text is re-parsed by the gateway into OpenAI `tool_calls` format — the client stays on the standard format and is unaware of the trick.

### Why use it?

**1. Partial argument chunking** — native function calling on Gemini sends arguments as one atomic chunk, so the client never sees arguments "typing" progressively. `tools-text` turns arguments into text generation → **streamed token-by-token** (much better UX, spinner resolves progressively).

**2. Bypass provider quirks** — Gemini 3.x native function calling requires a `thought_signature` on every turn (missing it → 400), leaks `extra_content`, and sometimes emits `finish_reason:"stop"` even when there's a tool call. `tools-text` **bypasses all of that** — no signature, no extra_content, finish_reason controlled by the gateway.

**3. ~50% token savings** — native tool definitions are heavy nested JSON schema (~50+ tokens/tool). `tools-text` turns them into a compact bullet list (`- read_file(path: string)`). DeepSeek benchmark:
- Input: **−49%** (4 tools: 432 → 205 tokens)
- Output: **−33%** (68 → 39 tokens)
- Reasoning: −35%

**4. Enables tool calling on models/providers without native support** — as long as a model can chat + follow instructions, it can "call tools" via the XML pattern. This unlocks tool calling for completion-only models, local models (Ollama/vLLM without tool schema), or OpenAI-compat providers that haven't implemented native function calling.

### How it works

```
CLIENT (OpenAI format)          GATEWAY                    LLM (text gen)
──────────────────              ────────                   ─────────────
messages[] + tools[]    ───▶   inject XML sys prompt  ───▶  generate text
  system: persona              tool_calls history → XML      with <tool_call> tags
  assistant.tool_calls         role:tool → [TOOL_RESULT]     (streamed token-by-token)
                                    │
                                    ▼
                              re-parse XML          ◀───  stream text chunks
                                    │
                                    ▼
CLIENT (OpenAI format)  ◀───  emit delta.tool_calls[]
  delta.tool_calls[]            per index (PARTIAL CHUNKING!)
  finish_reason: tool_calls
```

### How to use

In **Admin → Routes → edit a chat route → add target → pick modality** `Tools (text/XML)` (alongside `responses`). Or set the route's default modality to `tools-text`. Works with any OpenAI-compat provider (DeepSeek, Gemini, OpenAI, Groq, etc.) — it reuses the chat endpoint.

Modality variants:
- `tools-text` — auto mode, follows the client request's `stream` flag (backward compatible)
- `tools-text-stream` — when the client uses `stream:true`, tool arguments are streamed token-by-token
- `tools-text-nonstream` — when the client uses `stream:true`, the gateway still uses the upstream `tools-text` path but buffers tool arguments until complete, then emits one complete tool call

When the client uses `stream:false`, all `tools-text*` variants use the normal non-stream path. The gateway uses the already-parsed chat request `body.stream`; it does not parse the request body a second time just to choose this variant.

### Trade-offs

- Tool selection is prompt-based (can pick wrong, but tested reliable — modern LLMs follow the XML pattern well)
- Per-tool type validation is lost (the gateway parses JSON as-is; the client validates after execution)
- The gateway parser tolerates several messy model outputs: missing `</args>`, corrupted/split closing tags, whitespace after JSON, and XML-like text inside JSON strings.
- Streaming still cannot perfectly repair severely invalid JSON once argument chunks have already been sent, such as raw unescaped quotes inside a string. For long script/code arguments, allow enough `max_tokens` so the model can close the `<tool_call>`.
- For providers whose native path already chunks reliably (OpenAI, DeepSeek), the default `chat` modality remains the best option

---

## 🔀 Cross-vendor tool calling

Agentic loops (an LLM calling tools repeatedly until done) often involve
**failover between models of different vendors**. This becomes a problem because
each vendor has its own mandatory internal token that is **incompatible** with
the others:

| Vendor | Internal token | Required in multi-turn? |
|---|---|---|
| Gemini 3.x | `thought_signature` (on every `tool_call`) | Yes — missing → `400 missing signature` |
| DeepSeek (thinking) | `reasoning_content` (on the `assistant` message) | Yes — missing → `400 must be passed back` |

When a loop moves from DeepSeek to Gemini, the `tool_call` generated by DeepSeek
**has no** `thought_signature` → when that history is carried back to Gemini on
the next turn → **crash**. And vice versa.

### Solution: combine `chat` + `tools-text` per target

Set the per-target modality according to the vendor's characteristics. The rule
of thumb:

```
Provider with reliable native function calling (DeepSeek, OpenAI, …)  → chat
Provider with signature/quirks (Gemini 3.x)                           → tools-text
```

With this configuration, the gateway becomes a **two-way translator**:

```
Client (OpenAI format)  ↔  Gateway (translate)   ↔  DeepSeek (native tool_calls)
  clean tool_calls          convert 2-way             plain text, no signature concerns
                           (transparent)          ↔  Gemini  (XML text via tools-text)
```

**Why `tools-text` solves it:**
- Tool definitions & history (`tool_calls` + role `tool`) are converted to **universal XML text** — no native function call, no `thought_signature`, no `extra_content`.
- The client still sends/receives the original OpenAI `tool_calls` format — the gateway re-parses the XML text back into `tool_calls` on the response.
- Because the format is universal text, **no vendor-specific token leaks** during failover. Gemini receives the history as plain text → it doesn't complain about signatures.

### How to set it in the dashboard

1. **Admin → Routes → edit a chat route** (the one used for tool calling with cross-vendor failover)
2. In the target builder, for each target:
   - DeepSeek/OpenAI/… target → pick modality **`Chat`** (default)
   - Gemini target → pick modality **`Tools (text/XML)`** (or a stream/nonstream variant)
3. Save. Done — no restart needed, hot-reload is automatic.

> Note: this rule applies to routes **used for tool calling**. Plain chat routes
> (no `tools`) are fine using the `chat` modality on every target. The signature
> caches (`thought_signature` & `reasoning_content`) keep running automatically
> for single-vendor native scenarios, as an additional layer of defense.

---

## 🧠 Reasoning/thinking mapping

Every AI vendor controls "thinking" (reasoning) differently, and the supported
values even differ between model generations. SiberGate unifies this: the client
sends **one canonical shape** and the gateway auto-translates it to the target
provider's native dialect — including when failover switches vendors mid-flight
(each target is mapped independently).

### Canonical format (what the client sends)

A top-level OpenAI-style field, set to one of:

```json
{
  "model": "smart",
  "reasoning_effort": "high",
  "messages": [...]
}
```

| Value | Meaning |
|---|---|
| `"none"` | Disable reasoning (if the model supports it) |
| `"minimal"` | Very little reasoning |
| `"low"` | Shallow reasoning |
| `"medium"` | Balanced (default) |
| `"high"` | Deep |
| `"xhigh"` | Extra deep (OpenAI GPT-5.2+, DeepSeek→`max`) |
| `"max"` | Maximum (OpenAI GPT-5.2+, DeepSeek) |

The OpenAI nested form `reasoning: { effort: ... }` is also accepted.

### Translation dictionary

The gateway detects the target from **`provider.id` + model name**, then maps:

| Target provider | Native shape sent upstream |
|---|---|
| **OpenAI** (o3, GPT-5.x) & compat (Mistral, Groq gpt-oss, Together, …) | `reasoning_effort` (top-level, `xhigh`→`high`); GPT-5.2+ uses nested `reasoning:{effort}` & accepts `none`/`minimal`/`xhigh`/`max` |
| **Anthropic** Claude 4.x/5 | `thinking: { type: "adaptive" }` + `effort: <e>` |
| **Anthropic** Claude 3.7 (legacy) | `thinking: { type: "enabled", budget_tokens: <N> }` |
| **Anthropic** Claude 3.5 & older | (unsupported) — field stripped |
| **Gemini** (2.5/3.x) | `reasoning_effort` top-level (Google maps it internally to thinking_level/thinking_budget). `none` clamped: 3.x & 2.5 Pro → `minimal` (cannot disable); 2.5 Flash/Flash-Lite → `none` (off) |
| **OpenRouter** | `reasoning: { effort: <e> }` (OR normalizes to the backing provider) |
| **xAI Grok** 4.5+ | nested `reasoning:{effort}` (low/medium/high); `none`→`low` (cannot disable) |
| **Mistral** | `reasoning_effort` (`high`/`none` only; medium/low→high) |
| **Cohere** (compat) | `reasoning_effort` (`none`/`high` only; medium/low→high) |
| **Z.AI GLM** 4.6+ | `thinking:{type:"enabled"\|"disabled"}` (on/off toggle) |
| **Kimi/Moonshot** (K2.5+) | `thinking:{type:"enabled"\|"disabled"}` (on/off toggle) |
| **Qwen Cloud** (qwen3.x) | `enable_thinking: true\|false` + `thinking_budget` (`none`→false, others→true+budget) |
| **DeepSeek** V4-Pro/Flash | `reasoning_effort` (`low`/`high`/`max`); `none`→`thinking:{type:"disabled"}` |

**`none`** is translated to each provider's native "off" field when one exists
(Anthropic `thinking:{type:"disabled"}`, Gemini `thinkingBudget:0`), so the
client can turn off reasoning on models that are reasoning-on by default.

Token budgets for budget-based formats: `minimal`→512, `low`→1024,
`medium`→4096, `high`→16384, `xhigh`→32768.

### Precedence rules & two-way translation

- **Client sends no reasoning intent** → the gateway changes nothing (provider
  defaults apply — backward compatible).
- **Client sends a provider-A native field** (`thinking`, `thinkingConfig`,
  `reasoning.max_tokens`, …) → the gateway **normalizes** it to the canonical
  effort level, then re-translates to the **target's** native format. The
  original field is stripped so no two conflicting shapes are sent.
- **Cross-vendor failover** → each target is re-mapped to its own format (the
  gateway never mutates the original body — it always builds a fresh object).

This matters because routes are masked (the client sends a virtual route id,
not a real model) and failover can switch vendors mid-flight. Example: the
client sends `thinking:{type:"adaptive", effort:"high"}` (Anthropic-style) —
if the route lands on Gemini, the gateway rewrites it to
`thinkingConfig:{thinkingBudget:16384}`, and vice-versa. The client never needs
to know which vendor ends up serving the request.

### Target detection (hybrid)

The gateway picks the format in two layers:
1. **Known `provider.id`** (openai/anthropic/gemini/deepseek/xai/mistral/cohere/zai/kimi/qwen/openrouter) → that vendor's native mapping.
2. **Inference host / unknown provider** (Groq/Novita/Together/Fireworks/Ollama/vLLM/unknown) → detect the **model name** (`glm-*`, `deepseek-*`, `kimi-*`, `qwen*`, `claude`, `grok-*`, `gemini-*`, `mistral*`, `command-*`) and use that model's native mapping. This matters: a vendor-owned model (e.g. GLM) needs its native field (`thinking:{type}`) even when hosted on Novita/Fireworks. OpenAI-family models (`gpt-*`, `o3`) and unrecognized models → flat `reasoning_effort` (safe for OpenAI-compat hosts that translate themselves).

### How it works

```
Client: { model: "smart", reasoning_effort: "high", messages: [...] }
  │
  ▼ executeRoute → target Claude → adapter → MAPPER
  │                                        ↓
  │   { ..., thinking: { type: "adaptive" }, effort: "high" }
  │
  ▼ failover → target Gemini → MAPPER re-runs (different format)
                 { ..., generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } } }
```

The mapping runs in each chat-relevant adapter (`chat`, `responses`,
`tools-text`) just before the body is serialized upstream — so there are no
changes to the engine, routing, or SSE streaming. No DB/config required; the
feature is pure logic, transparent, and on by default.

---

## 🔌 API reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/v1/models` | List enabled routes (tagged with modality) |
| `POST` | `/v1/chat/completions` | Chat (streaming + JSON) |
| `POST` | `/v1/images/generations` | Image generation |
| `POST` | `/v1/audio/speech` | Text-to-speech (binary) |
| `POST` | `/v1/audio/transcriptions` | Speech-to-text |
| `POST` | `/v1/embeddings` | Text embeddings |
| `POST` | `/v1/music/generations` | Text-to-music (SiberGate extension) |
| `ANY` | `/v1/generic/:routeId/*` | **Generic REST passthrough** — proxy any non-LLM API (GET/POST/PUT/PATCH/DELETE); body & response forwarded verbatim (SiberGate extension) |

`model` is always a **route id** (e.g. `smart`), not a vendor model id. Errors
follow the OpenAI envelope: `{ "error": { message, type, param, code } }`.

> **The `generic` modality** selects its route from the path
> (`/v1/generic/:routeId`) instead of a `model` body field. The client's method,
> headers, and body are forwarded as-is to the upstream; the upstream status code
> and response are returned verbatim. Ideal for proxying REST APIs, webhooks, or
> internal microservices with the same routing + failover.

> **Header passthrough to the LLM** — by default the gateway sends only
> essential headers upstream (`Content-Type` + provider credentials). Client
> headers (`Authorization sg_live_*`, cookies, …) are **not forwarded**, for
> security and isolation. However, a selected set of client headers can be
> **forwarded** to the provider via an allowlist — useful when a provider needs
> custom headers (e.g. `HTTP-Referer` / `X-Title` for OpenRouter attribution,
> or a custom `User-Agent`).
>
> Default allowlist: `user-agent`, `http-referer`, `x-title`, `x-request-id`,
> `accept-language`. Override via env:
> ```bash
> SIBERGATE_PASSTHROUGH_HEADERS=user-agent,x-my-custom-header,x-app-name
> ```
> Sensitive headers (`authorization`, `cookie`, `api-key`, `x-api-key`) are
> **never** forwarded even if listed in the env. For static per-provider headers
> (fixed values), use the `headers` (JSON) field in the provider config
> (Admin → Providers → edit → headers).

---

## 🧱 Tech stack

| Layer | Choice |
|---|---|
| Runtime | **Node 20+** / Bun, **tsx** for dev |
| HTTP | **Hono** (fast, type-safe, great streaming) |
| Database | **SQLite** (`better-sqlite3`) — one file, no server |
| Crypto | **AES-256-GCM** (auto-generated master key) |
| Admin UI | **Next.js 15 + shadcn/ui + Tailwind** |
| Charts | **Recharts** |
| Data fetching | **TanStack Query** |

### Monorepo layout (npm workspaces)
```
sibergate/
├── packages/
│   ├── core/        @sibergate/core    → db, crypto, config, engine, adapters, admin
│   ├── gateway/     @sibergate/gateway → Hono server + OpenAI-compat routes
│   └── admin/       @sibergate/admin   → Next.js dashboard
├── scripts/seed.ts                     → seed runner
├── sibergate.config.json               → master-data seed file
└── .env                                → provider keys (gitignored)
```

---

## 🔐 Security

- Provider credentials are **AES-256-GCM encrypted** at rest. Master key auto-generates at `.sibergate/master-key` (gitignored); pin it via `SIBERGATE_MASTER_KEY` for multi-host deploys.
- Client API keys are **sha256-hashed**; plaintext shown once at creation.
- The admin key lives server-side only — the browser hits a proxy route that injects it.
- Decryption is transient (in-memory at request time); keys are never logged.
- **Upstream auth schemes** — pick per provider to match the target API: `bearer` (default, OpenAI-style), `x-api-key` (Anthropic-style), `query` (`?api_key=`), `basic` (HTTP Basic), or `none` (public APIs). The key stays encrypted at rest regardless of scheme.

---

## 🚀 Deployment (PM2)

For a production server, run the gateway + admin as managed processes that
auto-restart and survive reboots via [PM2](https://pm2.keymetrics.io/). An
`ecosystem.config.cjs` file is included.

```bash
npm install -g pm2
npm install && npm run build      # build once (core + gateway + admin)
pm2 start ecosystem.config.cjs    # start gateway + admin together
pm2 logs                          # tail both processes' logs
pm2 save && pm2 startup           # auto-start on server reboot (once)
```

| Action | Command |
|---|---|
| View status | `pm2 status` |
| Restart after code/env change | `npm run build && pm2 restart all` |
| Stop / remove | `pm2 stop all` / `pm2 delete all` |

Logs are written to `./logs/` (already gitignored). The admin port is still read
from `packages/admin/.env.local` (`SIBERGATE_ADMIN_PORT`), so changing the port
works the same as in dev mode.

---

## 🗂️ Raw request trace (debugging upstream errors)

When an **upstream error** occurs — whether a terminal failure (5xx/4xx status)
or a **recovered failover** (a target failed in the trail) — SiberGate
automatically saves the **full raw request** to a per-request file on disk. This
helps operators reproduce and diagnose provider errors without guessing the
request contents from the DB log.

### Why files, not the DB?
Raw request bodies (messages, tools, headers) can be large. Storing them
per-request in SQLite would bloat the DB fast. The solution: **one `.json` file
per request**, stored in `<cwd>/request_traces/` (override via
`SIBERGATE_TRACE_DIR`). The DB stays lean — it only stores a `metadata.hasTrace`
flag so the UI knows when to show the "View raw request" link.

### Contents of `request_traces/<requestId>.json`
```json
{
  "requestId": "uuid",
  "ts": "2026-08-02T...",
  "client": {
    "method": "POST",
    "path": "/v1/chat/completions",
    "ip": "1.2.3.4",
    "headers": { "authorization": "Bearer ***", "content-type": "..." }
  },
  "body": { "model": "...", "messages": [...], "tools": [...] },
  "upstream": { "url": "https://api.gemini.com/...?key=***", "status": 400, "responseBody": "..." },
  "route": "nebula/ds-flash"
}
```
**Secrets are redacted:** `Authorization`, `x-api-key`, `cookie`, and the
`api_key`/`key`/`token` query params are replaced with `***` before writing.
File mode is `0o600`.

### How to access
In **Logs → click a row → detail drawer**, a **"View raw request"** button
appears only when `hasTrace` is true. Click it → a modal shows the client request
(method, path, headers, body) + the upstream call (URL, status, response body).

Internal endpoint: `GET /admin/requests/:id/trace` (proxied via `/api/admin/*`,
admin key injected server-side). `:id` can be a numeric row id or the requestId
UUID.

### Lifecycle & cleanup
Files are created **only on error** (not on every request). When an operator:
- **Clears logs** (Settings → Maintenance) → all `request_traces/` files are deleted.
- **Resets stats** → same (inherits from clearLogs).
- **Resets all data** → cleaned up too.

No orphaned files linger after logs are cleared.

---


## 🤝 Contributing

Contributions are welcome! This is part of the **Siber ecosystem** and we'd love
to grow it with the community.

1. Fork & clone the repo
2. `npm install && npm run dev`
3. Make your change (please keep the two-pillar architecture intact)
4. Open a PR describing what & why

For major changes, please open an issue first to discuss the direction.

---

## 📄 License

Released under the **MIT License**. See [LICENSE](./LICENSE).

You're free to use, modify, and distribute SiberGate — including commercially.
Attribution to **DataSiberLab** and the Siber ecosystem is appreciated but not
required.

---

## 📬 Contact & Community

<div align="center">

**Built with ❤️ by [DataSiberLab](https://datasiber.com)** as part of the Siber ecosystem.

📧 **Contact:** [candrapwr@datasiber.com](mailto:candrapwr@datasiber.com)
🌐 **Website:** [datasiber.com](https://datasiber.com)

Found SiberGate useful? ⭐ Star the repo and share it with fellow builders!

</div>
