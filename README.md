<div align="center">

# 🚪 SiberGate

**The self-hosted AI gateway that routes intelligently across every provider.**

One OpenAI-compatible endpoint. Six modalities. Smart fallback, fastest-pick,
and load balancing — all on your own infrastructure, with zero markup.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![Providers](https://img.shields.io/badge/providers-16-orange.svg)](#-built-in-catalog)
[![Models](https://img.shields.io/badge/models-149-orange.svg)](#-built-in-catalog)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#-contributing)

</div>

---

> 🌐 **Part of the [Siber Ecosystem](https://datasiber.id)** — built & maintained by **DataSiberLab**.

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
- **🎨 Six modalities** — chat, image generation, text-to-speech, transcription, embeddings, and **text-to-music** (DeepInfra ACE-Step).
- **🛡️ Seamless failover** — a provider goes down? SiberGate silently moves to the next. Your client never notices.
- **🔐 Centralized key vault** — clients only ever see a `sg_live_*` key. Real provider keys are encrypted at rest, decrypted transiently at request time, and never logged.
- **📊 Built-in observability** — per-request logs, token & cost tracking by route/provider/model, live dashboard with charts.
- **🖥️ Admin dashboard** — full CRUD for providers, models, routes, and keys; a chat & media playground; Postman-style code snippets in 6 languages.
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
npm run dev      # gateway :8787 + admin dashboard :3000
```

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

Or open **http://localhost:3000** for the admin dashboard.

---

## 🏗️ Architecture — two pillars

### 1. Master Data (SQLite — single source of truth)
- **Providers** — vendor endpoints + per-modality URL templates + **AES-256-GCM encrypted credentials**
- **Models** — specs with **JSON modalities** (`text-to-text`, `vision`, `image-generation`, `audio`, `embeddings`, …) so adding new capability types is a data change, not a code change
- **API keys** — client keys (sha256-hashed; plaintext shown once at creation)

### 2. Routing Engine (operational)
- **Routes** — virtual client-facing endpoints (`smart`, `chat`, `image-fast`, …) tagged with a modality
- **Route targets** — ordered `(provider, model, weight)` mappings; filtered to providers that actually support the route's modality
- **Strategies** — `fallback`, `fastest` (EMA latency), `weighted`
- **Requests** — per-request log (latency, tokens, cost, errors, served-by)

The polymorphic **provider adapter** dispatches each request to the right
modality handler (chat / image / speech / transcribe / embed / music), so one
gateway serves them all.

---

## 📦 Built-in catalog

SiberGate ships with a curated catalog of **16 providers** and **149 models** —
importable with one click (empty credentials; you set the keys afterward).

| Provider | Highlights |
|---|---|
| **OpenAI** | GPT-5, GPT-4.1, o3, DALL·E, TTS, Whisper, embeddings |
| **Anthropic** | Claude Opus 4.1, Sonnet 4/4.5, Haiku 4.5 |
| **Google Gemini** | 2.5 Pro/Flash/Flash-Lite, nano banana image |
| **DeepSeek** | V3, R1 |
| **Groq** | Llama 4 Scout/Maverick, Whisper v3, PlayAI TTS |
| **xAI** | Grok 4, Grok 4 Fast |
| **Mistral** | Large/Medium/Small, Pixtral, Embed |
| **Novita AI** | DeepSeek/Llama/Qwen via Novita + FLUX/SDXL images |
| **DeepInfra** | ACE-Step text-to-music, FLUX, Llama 4 |
| **OpenRouter, Together, Fireworks, Cohere, Perplexity, Ollama, vLLM** | … |

_Settings → "Import catalog" → fill keys → done._

---

## 🖥️ Admin Dashboard

A dark-themed dashboard (Next.js + shadcn/ui) at `http://localhost:3000`:

- **Dashboard** — live stats (requests, success rate, tokens, spend) + charts by route/provider/model
- **Usage** — token & cost monitoring across providers, models, and routes; provider×model matrix
- **Providers / Models / Routes / API Keys** — full CRUD with inline forms; route form filters models by selected modality
- **Logs** — filterable request table + detail drawer
- **Chat Playground** — test routes with live SSE streaming
- **Media Lab** — generate & preview images, speech, and music inline
- **Route testing** — probe any route and visualize the failover path
- **Code snippets** — Postman-style client code in cURL / Node / Python / PHP / Go

The admin key is injected server-side via a proxy route — it never reaches the
browser. The playground uses a separate client key (`sg_live_*`).

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

`model` is always a **route id** (e.g. `smart`), not a vendor model id. Errors
follow the OpenAI envelope: `{ "error": { message, type, param, code } }`.

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

---

## 🗺️ Roadmap

- [x] Core gateway (chat) + routing engine (fallback/fastest/weighted)
- [x] Multi-modality (image, speech, transcribe, embed, music)
- [x] Admin dashboard (CRUD, logs, usage, playground, media lab)
- [x] Built-in provider catalog (16 providers, 149 models)
- [ ] Response caching (exact-match)
- [ ] Budget guards (monthly spend caps per key)
- [ ] Video generation (Runway/Pika)
- [ ] OpenTelemetry metrics export
- [ ] Helm chart for Kubernetes

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

**Built with ❤️ by [DataSiberLab](https://datasiber.id)** as part of the Siber ecosystem.

📧 **Contact:** [candrapwr@datasiber.id](mailto:candrapwr@datasiber.id)
🌐 **Website:** [datasiber.id](https://datasiber.id)

Found SiberGate useful? ⭐ Star the repo and share it with fellow builders!

</div>
