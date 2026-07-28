<div align="center">

# 🚪 SiberGate

**Gateway AI self-hosted yang merutekan secara cerdas ke seluruh provider.**

Satu endpoint kompatibel OpenAI. Enam modalitas AI, plus passthrough REST generik.
Failover otomatis, pemilihan tercepat, dan load balancing — semuanya di
infrastruktur Anda sendiri, tanpa markup.

[![Lisensi: MIT](https://img.shields.io/badge/lisensi-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![Provider](https://img.shields.io/badge/provider-18-orange.svg)](#-katalog-bawaan)
[![Model](https://img.shields.io/badge/model-206-orange.svg)](#-katalog-bawaan)
[![PR diterima](https://img.shields.io/badge/PR-diterima-brightgreen.svg)](#-berkontribusi)
[![Status](https://img.shields.io/badge/status-aktif-maintained-success.svg)](#-roadmap)
[![Bintang](https://img.shields.io/github/stars/candrapwr/sibergate?style=social&label=Star)](https://github.com/candrapwr/sibergate/stargazers)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

---

> 📖 **[Read in English](./README.en.md)** · 🌐 **Bagian dari [Ekosistem Siber](https://datasiber.com)** — dibangun & dirawat oleh **DataSiberLab**.

SiberGate adalah **reverse proxy** open-source yang berdiri di depan provider
LLM, gambar, audio, dan embedding Anda. Alih-alih meng-hard-code satu vendor ke
setiap aplikasi, Anda arahkan klien ke SiberGate dan biarkan ia mengurus
bagian sulitnya: routing, failover, load balancing, pelacakan biaya, dan
manajemen kredensial — semuanya lewat dashboard admin yang bersih.

```bash
# Arahkan klien OpenAI SDK apa pun ke SiberGate — selesai.
const client = new OpenAI({ baseURL: "http://localhost:8787/v1", apiKey: "sg_live_..." });
await client.chat.completions.create({ model: "smart", messages: [...] });
```

<p align="center">
  <img src="images/dashboard.png" alt="Dashboard Admin SiberGate" width="100%" />
</p>

---

## ✨ Apakah SiberGate cocok untuk Anda?

SiberGate adalah gateway **self-hosted** — Anda menjalankannya di mesin sendiri,
dengan key provider Anda sendiri. Ini cocok banget ketika hal-hal berikut penting:

- 🔒 **Privasi & lokasi data** — prompt dan respons tetap di dalam infrastruktur
  Anda. Tidak ada yg dirutekan lewat pihak ketiga. Ideal untuk industri teregulasi,
  beban kerja sensitif, atau sekadar menghargai data Anda.
- 💰 **Tanpa markup** — Anda memanggil provider dengan key sendiri dan membayar
  mereka langsung. Tidak ada biaya perantara di atas setiap token.
- 🎛️ **Kontrol penuh** — Anda punya logic routing, brankas key, log, dan
  dashboard. Tidak ada akun yang bisa di-rate-limit atau dibekukan.
- 🎨 **Lebih dari sekadar chat** — gambar, suara, transkripsi, embedding, bahkan
  text-to-music lewat satu gateway, dengan strategi routing untuk masing-masing.
- 💾 **SQLite tanpa ops** — satu file, tidak perlu Postgres atau Redis untuk
  deployment single-node. Portabel, mudah backup, mudah dipahami.

> Lebih suka layanan fully managed tanpa infrastruktur dengan marketplace publik?
> Itu kategori berbeda, dan banyak pilihan bagus di sana. SiberGate untuk saat
> Anda ingin **memiliki gateway-nya sendiri**.

### 🎯 Fitur unggulan

- **🔌 Satu endpoint, semua provider** — OpenAI, DeepSeek, Anthropic, Gemini, Groq, Mistral, dan 10+ lainnya, disatukan di balik API OpenAI yang sudah Anda pakai.
- **🧠 Routing cerdas** — `fallback` (failover otomatis), `fastest` (pilih latency terendah), `weighted` (load balancing). Strategi berlaku untuk semua modalitas.
- **🎨 Enam modalitas AI + passthrough REST + Responses API** — chat, image generation, text-to-speech, transkripsi, embedding, dan **text-to-music** (DeepInfra ACE-Step), plus modality **generic** yang mem-proxy API non-LLM apa pun (GET/POST/PUT/DELETE) dengan routing + failover yang sama. Ada juga modality **responses** untuk provider OpenAI-compat Responses API — klien tetap format chat/completions, gateway yang auto-convert dua arah (termasuk streaming SSE dan tool/function calling).
- **🛠️ Tool/function calling penuh di Responses** — definisi tools, `tool_calls` di response (streaming maupun non-streaming), `finish_reason: tool_calls`, dan multi-turn (role `tool` → `function_call_output`) — semuanya di-convert transparan dari/ke format chat/completions.
- **🪄 Tool calling via text/XML (`tools-text`)** — modality paralel yg membungkam native function calling dgn alasan kuat: (1) **chunk parsial** argumen token-by-token (UX typing, vs native Gemini yg atomic); (2) **bypass quirk provider** — tidak ada `thought_signature`, `extra_content`, atau `finish_reason` salah di Gemini; (3) **hemat ~50% token** (input −49%, output −33%, krn tool definition compact vs JSON schema berat); (4) **enable tool calling di model/provider yg sebelumnya tidak support** native function calling — cukup mampu chat. Gateway inject system prompt pattern `<tool_call><name>..</name><args>..</args></tool_call>`, stream text di-reparse ke format OpenAI. Opt-in per route target. Lihat [Tool calling via text/XML](#-tool-calling-via-textxml-tools-text).
- **🖼️ Image generation async (Kling/vd2 style)** — beberapa provider tidak langsung balas URL gambar, tapi kembalikan `task_id`. SiberGate otomatis poll endpoint status tiap 5 detik (maks 10×), lalu kembalikan format OpenAI `{created, data:[{url}]}` ke klien. Provider sync (DALL-E, dll) tetap diteruskan verbatim.
- **🔀 Modality per-target** — dalam satu route chat, tiap target boleh punya modality sendiri (mis. OpenAI via Responses, DeepSeek via chat). Failover antar-modality berfungsi penuh — gateway ganti converter di tengah jalan.
- **🔑 Multi API key per provider** — satu provider boleh punya **banyak key** (mis. beberapa akun OpenAI/Gemini), masing-masing diberi label. Setiap route target menunjuk key spesifik (`provider → model → key`) — berguna untuk load-balance antar akun atau isolasi quota. Satu key ditandai **default** (dipakai saat target tidak specify key). Statistik tersedia **per upstream key**.
- **🔑 Preservasi otomatis `thought_signature` Gemini** — multi-turn tool/function calling di Gemini 3.x butuh signature khusus di setiap turn. SiberGate otomatis capture signature dari response, strip dari payload ke klien (format OpenAI murni), lalu inject balik saat request multi-turn datang — **transparan, klien tidak perlu ubah kode**. Lihat [Kompatibilitas khusus Gemini](#-kompatibilitas-khusus-gemini).
- **🌐 Gateway untuk API biasa juga** — lewat `/v1/generic/<route>/*` (route id boleh multi-segment, mis. `team/prod/chat`), SiberGate bisa dijadikan reverse proxy untuk REST API, webhook, atau microservice internal — dengan brankas key, failover, dan logging yang sama.
- **🛡️ Failover mulus** — provider down? SiberGate diam-diam pindah ke berikutnya. Klien Anda tidak sadar.
- **🔐 Brankas key terpusat** — klien hanya lihat key `sg_live_*`. Key provider asli (default maupun tambahan) di-encrypt saat disimpan (AES-256-GCM), didekripsi sesaat saat request, tidak pernah di-log. Plaintext tidak pernah dikembalikan API — hanya label + prefix redacted.
- **📊 Observabilitas bawaan** — log per-request, pelacakan token & biaya per route/provider/model/**upstream key**, dashboard live dengan grafik. Tiap error upstream mencatat **URL + response body** lengkap (key di-redact) supaya mudah diagnosa.
- **🖥️ Dashboard admin** — CRUD penuh untuk provider, model, route, dan key; playground chat & media; snippet kode gaya Postman dalam 6 bahasa.
- **💾 SQLite, tanpa ops** — satu file, tidak ada server database yang harus dijalankan. Master data, log, dan kredensial dalam satu DB portabel.
- **🔮 Tahan masa depan** — modalitas JSON artinya menambah kapabilitas baru (video, eksekusi kode) cuma ubah data, bukan refactor kode.

---

## 🚀 Mulai cepat

### Prasyarat
- [Node.js](https://nodejs.org) ≥ 20 (atau [Bun](https://bun.sh))
- Itu saja. SQLite sudah dibundle; tidak perlu Postgres/Redis.

### 1. Install
```bash
git clone <repo-url> sibergate && cd sibergate
npm install
```

### 2. Konfigurasi
```bash
cp .env.example .env
# Tambahkan minimal satu key provider, mis. OPENAI_API_KEY=sk-...
# Opsional: set SIBERGATE_ADMIN_KEY untuk mem-pin token admin
```

### 3. Seed & jalankan
```bash
npm run seed     # meng-encrypt key ke SQLite, mencetak key API klien
npm run dev      # gateway :8787 + dashboard admin :3000 (hot-reload, untuk development)
```

> **Production / self-host** — build sekali lalu jalankan kedua layanan bareng:
> ```bash
> npm run build    # build core + gateway + admin
> npm start        # gateway :8787 + admin :3000 (mode produksi, tanpa hot-reload)
> ```
> Lihat juga [bagian Deployment (PM2)](#-deployment-pm2) di bawah untuk auto-restart & boot-on-reboot.

**Port bisa diubah.** Gateway via `SIBERGATE_PORT` di `.env`; admin via `SIBERGATE_ADMIN_PORT`
di `packages/admin/.env.local` (default `3000`). Contoh: admin di port `8010` —
tambah `SIBERGATE_ADMIN_PORT=8010` ke `packages/admin/.env.local`, lalu restart.

### 4. Coba
```bash
# Chat via gateway
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer sg_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"smart","messages":[{"role":"user","content":"Halo!"}]}'

# Generate gambar
curl http://localhost:8787/v1/images/generations \
  -H "Authorization: Bearer sg_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"image-fast","prompt":"kucing astronot"}'
```

Atau buka **http://localhost:3000** (atau port `SIBERGATE_ADMIN_PORT` yang Anda set) untuk dashboard admin.

---

## 🏗️ Arsitektur — dua pilar

### 1. Master Data (SQLite — sumber kebenaran tunggal)
- **Provider** — endpoint vendor + template URL per-modalitas + **kredensial ter-encrypt AES-256-GCM**
- **Provider keys** — **multi-account**: satu provider boleh punya banyak key upstream (masing-masing berlabel + prefix redacted); tepat satu ditandai **default** (dipakai saat route target tidak specify key)
- **Model** — spesifikasi dengan **modalitas JSON** (`text-to-text`, `vision`, `image-generation`, `audio`, `embeddings`, …) sehingga menambah tipe kapabilitas baru hanya ubah data, bukan ubah kode
- **API key** — key klien (sha256-hash; plaintext ditampilkan sekali saat pembuatan)

### 2. Routing Engine (operasional)
- **Route** — endpoint virtual untuk klien (`smart`, `chat`, `image-fast`, …) diberi tag modalitas
- **Route target** — pemetaan `(provider, model, weight, key)` berurutan; difilter ke provider yang benar-benar support modalitas route tersebut; `key` opsional menunjuk key spesifik di provider (multi-account)
- **Strategi** — `fallback`, `fastest` (EMA latency), `weighted`
- **Signature cache** — in-memory cache `thought_signature` Gemini (per `tool_call.id`) utk multi-turn tool calling; TTL 1 jam, cap 5000, auto-evict
- **Request** — log per-request (latency, token, biaya, error, served-by, **key upstream mana yg melayani**)

**Adapter provider polymorphic** mengirim setiap request ke handler modalitas
yang tepat (chat / image / speech / transcribe / embed / music / generic), jadi
satu gateway melayani semuanya.

---

## 📦 Katalog bawaan

SiberGate dikirim dengan katalog kurasi **18 provider** dan **206 model** —
bisa di-import sekali klik (kredensial kosong; Anda isi key setelahnya).
Cakupan membentang 6 modalitas: text, vision, image-generation, audio
(TTS/music), audio-transcription, dan embeddings.

| Provider | Modalitas | Sorotan |
|---|---|---|
| **OpenAI** | chat · vision · image · speech · transcribe · embed | GPT-5.6 (Sol/Terra/Luna), GPT-5.5, GPT-5.4 family, GPT-5, GPT-4.1, o3/o4, GPT Image 2, DALL·E, Realtime, TTS, Whisper, embeddings |
| **Anthropic** | chat · vision | Claude Fable 5, Opus 4.8 / 4.7 / 4.6 / 4.5, Sonnet 5 / 4.6 / 4.5, Haiku 4.5, 3.7 / 3.5 line |
| **Google Gemini** | chat · vision · audio · image · embed | Gemini 3.5 Flash, 3.1 Pro / Flash-Lite, 3 Flash, 2.5 Pro / Flash, Nano Banana 2 / Pro, Lyria 3 (music), Flash TTS, embeddings |
| **DeepSeek** | chat | DeepSeek V4 Flash / Pro, V3, R1 |
| **Groq** | chat · transcribe | GPT OSS 120B / 20B, Llama 4 Scout, 3.3 70B, Qwen3, DeepSeek R1 distill, Whisper v3 / Turbo |
| **xAI (Grok)** | chat · vision · image | Grok 4.5 / 4.3 / 4.20 Reasoning, Grok Build, Grok Imagine (image + video) |
| **Mistral** | chat · vision · embed · audio | Mistral Large 3 / Medium 3.5 / Small 4, Pixtral Large / 12B, OCR 4, Voxtral TTS, Embed |
| **OpenRouter** | chat · vision | Auto (termurah), plus routing cross-vendor GPT-5.x / Claude / Gemini |
| **Together AI** | chat · vision · image | DeepSeek V4 Pro / Flash, Llama 4 / 3.3, Qwen 2.5 72B, FLUX.1 schnell / dev |
| **Fireworks AI** | chat · vision · image · transcribe | DeepSeek V4, GPT OSS 120B, Llama 4 Scout, Kimi K2.7, GLM 5.2, FLUX.1 dev, Whisper v3 |
| **Cohere** | chat · embed | Command A+ / A, R+ / R, Embed v3 (English + Multilingual) |
| **Perplexity** | chat | Sonar Pro, Sonar, Sonar Reasoning Pro |
| **Novita AI** | chat · image · embed | DeepSeek / Llama / Qwen via Novita + gambar FLUX.1 / SDXL / SD 3.5 |
| **DeepInfra** | chat · vision · image · music | ACE-Step text-to-music, FLUX.1, SD 3.5, Llama 4, DeepSeek R1 |
| **Z.AI (GLM)** | chat · vision · image · video · transcribe | GLM-5.2 / 5.1 / 5, GLM-4.7 / 4.6, GLM-V (vision), GLM-OCR, CogView-4, CogVideoX, Vidu (video), GLM-ASR |
| **Qwen Cloud** | chat · vision · audio · image · video · embed · transcribe | Qwen3.7-Max, Qwen3.6/3.5 series, Qwen-VL, Qwen-Omni (speech), Qwen Image 2.0, Wan 2.6 (video), CosyVoice TTS, embeddings |
| **Ollama** (lokal) | chat · vision · embed | Llama 3.3, Qwen 2.5, LLaVA, Nomic Embed |
| **vLLM** (lokal) | chat | Model HuggingFace apa pun yang Anda serve |

_Settings → "Import catalog" → isi key → selesai. Provider lokal (Ollama, vLLM)
tidak butuh key — cukup di-enabled._

---

## 🖥️ Dashboard Admin

Dashboard bertema gelap (Next.js + shadcn/ui) di `http://localhost:3000`:

<p align="center">
  <img src="images/dashboard.png" alt="Dashboard SiberGate" width="100%" />
</p>

### Tangkapan layar

<details>
<summary><b>📸 Lihat semua layar</b></summary>

| Layar | Pratinjau |
|---|---|
| **Dashboard** — statistik live, grafik per route/provider/model | <img src="images/dashboard.png" width="600" alt="Dashboard" /> |
| **Usage** — monitoring token & biaya, matriks provider×model | <img src="images/usage.png" width="600" alt="Usage" /> |
| **Providers** — CRUD dengan kredensial ter-encrypt | <img src="images/providers.png" width="600" alt="Providers" /> |
| **Models** — direktori dengan badge modalitas & filter | <img src="images/models.png" width="600" alt="Models" /> |
| **Routes** — endpoint virtual, modality + target builder | <img src="images/routes.png" width="600" alt="Routes" /> |
| **API Keys** — terbitkan & kelola key klien | <img src="images/api_keys.png" width="600" alt="API Keys" /> |
| **Logs** — tabel request terfilter + drawer detail | <img src="images/logs.png" width="600" alt="Logs" /> |
| **Chat Playground** — uji streaming SSE live | <img src="images/chat_playGround.png" width="600" alt="Chat Playground" /> |
| **Media Lab** — generasi gambar, suara & musik | <img src="images/media_lab.png" width="600" alt="Media Lab" /> |
| **Settings** — import katalog & danger zone | <img src="images/settings.png" width="600" alt="Settings" /> |

</details>

### Fitur

- **Dashboard** — statistik live (request, success rate, token, spend) + grafik per route/provider/model
- **Usage** — monitoring token & biaya lintas provider, model, route, **client API key**, dan **upstream key**; matriks provider×model
- **Providers / Models / Routes / API Keys** — CRUD penuh dengan form inline; form route memfilter model berdasarkan modalitas terpilih. Provider punya section **API keys** (multi-account) — tambah/hapus/set-default per key
- **Logs** — tabel request terfilter + drawer detail; tiap error upstream menampilkan panel **URL + response body** lengkap + trail failover (termasuk key upstream mana yg dipakai/gagal)
- **Chat Playground** — uji route dengan streaming SSE live
- **Media Lab** — generate & pratinjau gambar, suara, dan musik secara inline
- **Route testing** — probe route apa pun dan visualisasi path failover
- **Settings → Maintenance** — clear logs, reset stats, dan **clear signature cache** (Gemini `thought_signature`) manual
- **Code snippets** — kode klien gaya Postman dalam cURL / Node / Python / PHP / Go

Key admin di-inject server-side lewat route proxy — tidak pernah sampai browser.
Playground memakai key klien terpisah (`sg_live_*`).

---

## 🔧 Kompatibilitas khusus Gemini

Google Gemini 3.x punya beberapa kekhasan yang SiberGate tangani otomatis
sehingga klien tetap bisa pakai format OpenAI standar tanpa modifikasi:

### 1. Multi-turn tool/function calling (`thought_signature`)

Saat Gemini membalas tool call, ia menyertakan `thought_signature` (token
internal Google untuk tracking reasoning). Signature ini **wajib dikirim balik**
di pesan assistant pada turn berikutnya — kalau hilang, Gemini balas
`400 Function call is missing a thought_signature`.

Karena field ini tidak ada di format OpenAI, SiberGate menanganinya transparan:

1. **Capture** signature dari response Gemini → simpan di cache in-memory (key: `tool_call.id`)
2. **Strip** `extra_content` dari response → klien menerima format OpenAI murni
3. **Inject** signature balik ke `body.messages` saat request multi-turn datang → Gemini menerima payload lengkap

**Klien tidak perlu ubah apa pun** — kirim ulang assistant message dgn format OpenAI standar, gateway sisipkan signature otomatis.

**Spesifik & minim overhead** — hanya provider Gemini (langsung atau via OpenRouter) yg diproses; provider lain (DeepSeek, OpenAI, dll) skip otomatis. Cache: TTL 1 jam, cap 5000 entry, lazy eviction. Monitoring & clear manual ada di **Settings → Maintenance → Signature cache**.

### 2. Penamaan model & deprecation

Model Gemini lama (mis. `gemini-2.5-flash-lite`) sudah deprecated Google dan membalas `404 "no longer available to new users"`. Katalog SiberGate menyertakan model terbaru (`gemini-3.5-flash`, dll); kalau route Anda masih menunjuk model lama, ganti ke model baru via halaman Routes.

---

## 🪄 Tool calling via text/XML (`tools-text`)

Modality `tools-text` adalah alternatif native function calling dgn pendekatan berbeda: gateway membungkam tool definitions OpenAI, meng-inject system prompt pattern XML, dan membiarkan model melakukan **text generation** (yg di-stream token-by-token). Output text XML di-reparse gateway ke format OpenAI `tool_calls` — klien tetap format standar, tidak sadar ada trik.

### Kenapa pakai?

**1. Chunk parsial argumen** — native function calling Gemini mengirim argumen utuh dalam 1 chunk (atomic), shg client tidak melihat argumen "mengetik" progresif. `tools-text` mengubah argumen menjadi text generation → **di-stream token-by-token** (UX jauh lebih baik, spinner resolve progresif).

**2. Bypass quirk provider** — native function calling Gemini 3.x mengharuskan `thought_signature` di setiap turn (kalau hilang → 400), bocor `extra_content`, dan kadang `finish_reason:"stop"` padahal ada tool call. `tools-text` **bypass semua itu** — tidak ada signature, tidak ada extra_content, finish_reason dikontrol gateway.

**3. Hemat token ~50%** — tool definition native = JSON schema nested berat (~50+ token/tool). `tools-text` mengubahnya jadi bullet list compact (`- read_file(path: string)`). Hasil benchmark DeepSeek:
- Input: **−49%** (4 tools: 432 → 205 token)
- Output: **−33%** (68 → 39 token)
- Reasoning: −35%

**4. Enable tool calling di model/provider tanpa native support** — selama model bisa chat + ikuti instruction, ia bisa "memanggil tool" via pattern XML. Ini membuka tool calling utk model completion-only, model lokal (Ollama/vLLM tanpa tool schema), atau provider OpenAI-compat yg belum implement native function calling.

### Cara kerja

```
KLIEN (format OpenAI)            GATEWAY                    LLM (text gen)
──────────────────              ────────                   ─────────────
messages[] + tools[]    ───▶   inject XML sys prompt  ───▶  generate text
  system: persona              tool_calls history → XML      dgn <tool_call> tags
  assistant.tool_calls         role:tool → [TOOL_RESULT]     (stream token-by-token)
                                    │
                                    ▼
                              re-parse XML          ◀───  stream text chunks
                                    │
                                    ▼
KLIEN (format OpenAI)  ◀───  emit delta.tool_calls[]
  delta.tool_calls[]            per index (CHUNK PARSIAL!)
  finish_reason: tool_calls
```

### Cara pakai

Di **Admin → Routes → edit route chat → add target → pilih modality** `Tools (text/XML)` (selevel dgn `responses`). Atau set modality route default ke `tools-text`. Berlaku utk semua provider OpenAI-compat (DeepSeek, Gemini, OpenAI, Groq, dll) — reuse endpoint chat.

Varian modality:
- `tools-text` — auto, mengikuti `stream` dari request client (backward compatible)
- `tools-text-stream` — saat client `stream:true`, argumen tool di-stream parsial token-by-token
- `tools-text-nonstream` — saat client `stream:true`, gateway tetap memakai jalur `tools-text` upstream, tapi menahan argumen tool sampai lengkap lalu emit tool call sekali

Kalau client `stream:false`, semua varian `tools-text*` memakai jalur non-stream biasa. Gateway memakai `body.stream` yg sudah diparse sekali utk request chat; tidak ada parse body tambahan hanya utk memilih varian ini.

### Trade-off

- Tool selection prompt-based (bisa salah pilih, tapi teruji reliable — model LLM modern ikuti XML pattern dgn baik)
- Type validation per-tool hilang (gateway parse JSON apa adana; client validasi sendiri setelah eksekusi)
- Parser gateway toleran terhadap beberapa output model yg tidak rapi: `</args>` hilang, closing tag rusak/split, whitespace setelah JSON, dan teks mirip tag XML di dalam string JSON.
- Streaming tetap tidak bisa memperbaiki sempurna argumen yg sudah terkirim parsial bila model membuat JSON invalid berat (mis. quote mentah di dalam string). Untuk argumen panjang seperti script/code, beri `max_tokens` cukup supaya model sempat menutup `<tool_call>`.
- Utk provider yg native-nya sudah chunk + reliable (OpenAI, DeepSeek), modality `chat` default tetap opsi terbaik

---

## 🔌 Referensi API

| Method | Path | Deskripsi |
|---|---|---|
| `GET` | `/health` | Cek hidup |
| `GET` | `/v1/models` | Daftar route aktif (diberi tag modalitas) |
| `POST` | `/v1/chat/completions` | Chat (streaming + JSON) |
| `POST` | `/v1/images/generations` | Generasi gambar |
| `POST` | `/v1/audio/speech` | Text-to-speech (binary) |
| `POST` | `/v1/audio/transcriptions` | Speech-to-text |
| `POST` | `/v1/embeddings` | Embedding teks |
| `POST` | `/v1/music/generations` | Text-to-music (ekstensi SiberGate) |
| `ANY` | `/v1/generic/:routeId/*` | **Passthrough REST generik** — proxy API non-LLM (GET/POST/PUT/PATCH/DELETE), body & response diteruskan verbatim (ekstensi SiberGate) |

`model` selalu berupa **id route** (mis. `smart`), bukan id model vendor. Error
mengikuti envelope OpenAI: `{ "error": { message, type, param, code } }`.

> **Modality `generic`** memilih route dari path (`/v1/generic/:routeId`), bukan
> dari field `model` di body. Method, header, dan body klien diteruskan apa
> adanya ke upstream; status code & response upstream dikembalikan verbatim.
> Route id boleh multi-segment (`team/prod/chat`) — di-resolve via longest-prefix
> match. Cocok untuk mem-proxy REST API, webhook, atau microservice internal
> dengan routing + failover yang sama.

> **Modality `responses`** — klien tetap POST `/v1/chat/completions` dgn format
> chat/completions biasa. Jika route target punya modality ini, gateway
> meng-convert dua arah ke/dari OpenAI Responses API (`/v1/responses`):
> `messages` ↔ `input`, `system` → `instructions`, `max_tokens` →
> `max_output_tokens`, `output_items.output_text` → `choices[].message.content`,
> `input_tokens`/`output_tokens` → `prompt_tokens`/`completion_tokens`.
> Streaming SSE juga di-convert (`response.output_text.delta` → chat delta
> chunk). **Tool/function calling didukung penuh**: definisi `tools`, `tool_calls`
> di response (non-stream & streaming), `finish_reason: tool_calls`, serta
> multi-turn (assistant `tool_calls` ↔ Responses `function_call`, role `tool` ↔
> Responses `function_call_output`). Klien tidak perlu tahu backend pakai
> Responses API — cukup pilih route yg modality-nya `responses`. Hanya provider
> OpenAI-compat Responses.

> **Per-target modality override** — route dgn modality `chat` boleh memiliki
> target dgn modality berbeda. Di form Route, tiap baris target punya dropdown
> modality (default: ikut route; opsi: `responses`). Memungkinkan satu route
> campur target OpenAI (Responses) + DeepSeek (chat) dgn **failover antar-modality**
> otomatis. Route modality selain `chat` tidak bisa override (format modalitas
> lain berbeda total, mixing akan silent break).

> **Image generation async (Kling/vd2 style)** — sebagian provider image tidak
> langsung balas URL gambar; mereka kembalikan `data.task_id`. SiberGate
> mendeteksi response tsb, lalu otomatis poll `GET {endpoints.image}/{task_id}`
> tiap 5 detik (maks 10×) sampai `task_status: succeed`, lalu kembalikan format
> OpenAI `{created, data:[{url}]}` ke klien. Bila gagal/error atau habis retry,
> klien terima error OpenAI-compat (`image_task_failed`). Provider sync (DALL-E
> dan lainnya yg langsung balas URL) tetap diteruskan verbatim — deteksi otomatis
> lewat ada/tidaknya field `data.task_id`.

---

## 🧱 Tech stack

| Lapisan | Pilihan |
|---|---|
| Runtime | **Node 20+** / Bun, **tsx** untuk dev |
| HTTP | **Hono** (cepat, type-safe, streaming bagus) |
| Database | **SQLite** (`better-sqlite3`) — satu file, tanpa server |
| Kripto | **AES-256-GCM** (master key auto-generated) |
| Admin UI | **Next.js 15 + shadcn/ui + Tailwind** |
| Grafik | **Recharts** |
| Data fetching | **TanStack Query** |

### Layout monorepo (npm workspaces)
```
sibergate/
├── packages/
│   ├── core/        @sibergate/core    → db, crypto, config, engine, adapters, admin
│   ├── gateway/     @sibergate/gateway → server Hono + route OpenAI-compat
│   └── admin/       @sibergate/admin   → dashboard Next.js
├── scripts/seed.ts                     → runner seed
├── sibergate.config.json               → file seed master-data
└── .env                                → key provider (di-gitignore)
```

---

## 🔐 Keamanan

- Kredensial provider **di-encrypt AES-256-GCM** saat disimpan. Master key auto-generated di `.sibergate/master-key` (di-gitignore); pin via `SIBERGATE_MASTER_KEY` untuk deploy multi-host.
- Key API klien **di-hash sha256**; plaintext ditampilkan sekali saat pembuatan.
- Key admin hanya ada di server-side — browser mengakses route proxy yang meng-inject-nya.
- Dekripsi bersifat sementara (in-memory saat request); key tidak pernah di-log.
- **Skema autentikasi upstream** — pilih per provider sesuai kebutuhan API tujuan: `bearer` (default, gaya OpenAI), `x-api-key` (gaya Anthropic), `query` (`?api_key=`), `basic` (HTTP Basic), atau `none` (API publik). Key tetap di-encrypt saat disimpan apa pun skemanya.

---

## 🚀 Deployment (PM2)

Untuk server produksi, jalankan gateway + admin sebagai proses terkelola yang
auto-restart & nyala setelah reboot lewat [PM2](https://pm2.keymetrics.io/).
File `ecosystem.config.cjs` sudah disediakan.

```bash
npm install -g pm2
npm install && npm run build      # build sekali (core + gateway + admin)
pm2 start ecosystem.config.cjs    # start gateway + admin bareng
pm2 logs                          # tail log kedua proses
pm2 save && pm2 startup           # auto-start saat server reboot (sekali)
```

| Aksi | Perintah |
|---|---|
| Lihat status | `pm2 status` |
| Restart setelah ubah kode/env | `npm run build && pm2 restart all` |
| Stop / hapus | `pm2 stop all` / `pm2 delete all` |

Log ditulis ke `./logs/` (sudah di-gitignore). Port admin tetap dibaca dari
`packages/admin/.env.local` (`SIBERGATE_ADMIN_PORT`), jadi cara ganti port sama
seperti mode dev.

---

## 🗺️ Roadmap

- [x] Gateway inti (chat) + routing engine (fallback/fastest/weighted)
- [x] Multi-modalitas (image, speech, transcribe, embed, music)
- [x] Dashboard admin (CRUD, log, usage, playground, media lab)
- [x] Katalog provider bawaan (18 provider, 206 model)
- [ ] Response caching (exact-match)
- [ ] Budget guard (cap spend bulanan per key)
- [ ] Generasi video (Runway/Pika)
- [ ] Export metrik OpenTelemetry
- [ ] Helm chart untuk Kubernetes

---

## 🤝 Berkontribusi

Kontribusi diterima! Ini bagian dari **ekosistem Siber** dan kami senang
menumbuhkannya bersama komunitas.

1. Fork & clone repo
2. `npm install && npm run dev`
3. Buat perubahan Anda (mohon menjaga arsitektur dua pilar tetap utuh)
4. Buka PR menjelaskan apa & mengapa

Untuk perubahan besar, silakan buka issue dulu untuk mendiskusikan arahnya.

---

## 📄 Lisensi

Dirilis di bawah **Lisensi MIT**. Lihat [LICENSE](./LICENSE).

Anda bebas menggunakan, memodifikasi, dan mendistribusikan SiberGate — termasuk
secara komersial. Atribusi ke **DataSiberLab** dan ekosistem Siber dihargai
tapi tidak diwajibkan.

---

## 📬 Kontak & Komunitas

<div align="center">

**Dibuat dengan ❤️ oleh [DataSiberLab](https://datasiber.com)** sebagai bagian dari ekosistem Siber.

📧 **Kontak:** [candrapwr@datasiber.com](mailto:candrapwr@datasiber.com)
🌐 **Website:** [datasiber.com](https://datasiber.com)

SiberGate berguna? ⭐ Star repo-nya dan bagikan ke sesama builder!

</div>

<!-- repo: sibergate · dataSiberLab · 2026 -->

<!-- 2026-07-28T13:26:44Z -->

<!-- updated: 2026-07-28T13:52:50Z -->
