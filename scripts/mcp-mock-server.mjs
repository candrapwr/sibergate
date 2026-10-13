#!/usr/bin/env node
/**
 * Mock MCP server untuk testing SiberGate (protocol='mcp') — TANPA akun Kling.
 *
 * Mengimplementasikan:
 *   - Streamable HTTP MCP (JSON-RPC 2.0): initialize (dgn Mcp-Session-Id),
 *     notifications/initialized, tools/list, tools/call
 *   - Respons SSE (text/event-stream) untuk beberapa request — memvalidasi
 *     parser SSE SiberGate
 *   - OAuth 2.1 lengkap: /.well-known/oauth-protected-resource,
 *     /.well-known/oauth-authorization-server, dynamic client registration
 *     (RFC 7591), authorization endpoint (auto-approve), token endpoint
 *     (PKCE check), Bearer token di endpoint MCP
 *   - Tools ala Kling: who_am_i, text_to_image, image_to_image, text_to_video,
 *     image_to_video, query_tasks (async task: submit → poll sampai succeed),
 *     element_list
 *
 * Jalankan: node scripts/mcp-mock-server.mjs [port]   (default 9801)
 * Lalu di SiberGate: buat provider protocol='mcp' baseUrl
 * http://localhost:9801/mcp → Connect (OAuth mock auto-approve) → Sync tools.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const PORT = Number(process.argv[2] ?? 9801);
const HOST = '127.0.0.1';

/** Registered OAuth clients (dynamic registration). */
const clients = new Map(); // client_id -> {redirect_uris}
/** Authorization codes -> {clientId, codeVerifierChallenge} */
const authCodes = new Map();
/** Bearer tokens -> {providerId-ish label} */
const accessTokens = new Map(); // token -> {refreshToken}
const refreshTokens = new Map(); // refreshToken -> {}
/** MCP sessions. */
const sessions = new Map(); // sessionId -> {initialized: bool}
/** Async generation tasks. */
const tasks = new Map(); // generationId -> {kind, status, createdAt, pollCount}
/** ID counter. */
let n = 0;
const nextId = () => `gen_${++n}_${randomBytes(3).toString('hex')}`;

/** Schema envelope ala Kling ASLI (tools/list). */
const ENVELOPE_SCHEMA = {
  type: 'object',
  properties: {
    model: { type: 'string', description: 'Model to use; must be one of the models listed for this tool in who_am_i availableModels. Required.' },
    arguments: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] },
      description: 'Generation arguments as name/value pairs, e.g. [{"name": "prompt", "value": "a cat"}]. All values are strings.',
    },
    inputs: {
      type: 'array',
      items: { type: 'object', properties: { inputType: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' } }, required: ['inputType', 'name', 'url'] },
      description: "Resource inputs; each item is {name, inputType: 'URL', url}.",
    },
  },
  required: ['model', 'arguments'],
};

/** Ubah envelope Kling → flat utk diproses handler mock. */
function parseEnvelope(args) {
  const pairs = Object.fromEntries((args.arguments ?? []).map((p) => [p.name, p.value]));
  const inputs = Object.fromEntries((args.inputs ?? []).map((i) => [i.name, i.url]));
  return { ...pairs, model: args.model, __inputUrls: inputs };
}

const TOOLS = [
  {
    name: 'who_am_i',
    description: 'Returns the current user identity, along with the available models and parameter specifications for each generation tool.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    // ala Kling ASLI: envelope pairs — model top-level + arguments[{name,value}]
    // + inputs[{name,inputType,url}]. Detail per model hanya di who_am_i.
    name: 'text_to_image',
    description: 'Generates an image from a text prompt. Returns a generation_id; poll query_tasks for results.',
    inputSchema: ENVELOPE_SCHEMA,
  },
  {
    name: 'image_to_image',
    description: 'Image-to-image generation using a reference image and prompt. Returns a generation_id; poll query_tasks for results.',
    inputSchema: ENVELOPE_SCHEMA,
  },
  {
    name: 'text_to_video',
    description: 'Text-to-video generation. Returns a generation_id; poll query_tasks for status and results.',
    inputSchema: ENVELOPE_SCHEMA,
  },
  {
    name: 'image_to_video',
    description: 'Image-to-video generation (animate a static image). Returns a generation_id; poll query_tasks.',
    inputSchema: ENVELOPE_SCHEMA,
  },
  {
    name: 'query_tasks',
    description: 'Query generation status and final asset URL using generation_id.',
    inputSchema: {
      type: 'object',
      properties: {
        generation_id: { type: 'string', description: 'The generation task id' },
      },
      required: ['generation_id'],
    },
  },
  {
    name: 'element_list',
    description: "List Elements in the current account, including each Element's ID and name.",
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
];

/** Referensi model ala Kling ASLI: hanya dari who_am_i.availableModels. */
const AVAILABLE_MODELS = {
  text_to_image: {
    defaultModel: 'kling-v2',
    models: [
      { model: 'kling-v2', alias: 'Kling V2', description: 'Standard quality', arguments: [
        { name: 'prompt', required: true, description: 'Text prompt' },
        { name: 'model', required: true, description: 'Model variant' },
        { name: 'aspect_ratio', default: '1:1', allowedValues: ['1:1', '16:9', '9:16'] },
        { name: 'num_images', default: '1', allowedValues: ['1', '2', '3', '4'] },
      ], inputs: [] },
      { model: 'kling-v2-master', alias: 'Kling V2 Master, 可灵2.0大师版', description: 'Master quality', arguments: [
        { name: 'prompt', required: true, description: 'Text prompt' },
        { name: 'model', required: true, description: 'Model variant' },
        { name: 'aspect_ratio', default: '1:1', allowedValues: ['1:1', '16:9', '9:16'] },
      ], inputs: [] },
    ],
  },
  text_to_video: {
    defaultModel: 'kling-v2',
    models: [
      { model: 'kling-v2', alias: 'Kling V2', arguments: [
        { name: 'prompt', required: true },
        { name: 'model', required: true },
        { name: 'duration', default: '5', allowedValues: ['5', '10'] },
        { name: 'aspect_ratio', default: '16:9', allowedValues: ['16:9', '9:16', '1:1'] },
      ], inputs: [] },
      { model: 'kling-v2-master', alias: 'Kling V2 Master', arguments: [
        { name: 'prompt', required: true },
        { name: 'model', required: true },
        { name: 'duration', default: '5', allowedValues: ['5', '10'] },
      ], inputs: [] },
    ],
  },
  image_to_image: {
    defaultModel: 'kling-v2',
    models: [{ model: 'kling-v2', alias: 'Kling V2', arguments: [
      { name: 'prompt', required: true },
      { name: 'aspect_ratio', default: '1:1', allowedValues: ['1:1', '16:9', '9:16'] },
    ], inputs: [{ name: 'image_1', required: true, description: 'Reference image URL' }] }],
  },
  image_to_video: {
    defaultModel: 'kling-v2',
    models: [{ model: 'kling-v2', alias: 'Kling V2', arguments: [
      { name: 'prompt', required: true },
      { name: 'duration', default: '5', allowedValues: ['5', '10'] },
    ], inputs: [{ name: 'first_image', required: true, description: 'First frame image URL' }] }],
  },
};

/** Validasi ala Kling: parameter model WAJIB utk tool generasi. */
function requireModel(tool, args) {
  if (AVAILABLE_MODELS[tool] && !args.model) {
    return `Parameter 'model' is required. Available models for '${tool}': ${AVAILABLE_MODELS[tool].models.map((m) => m.model).join(', ')}. Call who_am_i and choose a model based on each model's description.`;
  }
  return null;
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sendJson(res, status, body, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...extraHeaders });
  res.end(buf);
}

/** Kirim respons SSE berisi satu pesan JSON-RPC (memvalidasi parser SSE klien). */
function sendSse(res, status, messages) {
  res.writeHead(status, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });
  for (const msg of messages) {
    res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
  }
  res.write(`event: ping\ndata: {"ts":${Date.now()}}\n\n`);
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function taskResult(task, id) {
  // Simulasi: butuh 2 poll sebelum succeed (image), 3 poll utk video.
  const pollsNeeded = task.kind === 'video' ? 3 : 2;
  // Model variant (bila dikirim) disertakan di nama file utk verifikasi mapping.
  const modelTag = task.args?.model ? `-${String(task.args.model).replace(/[^a-z0-9._-]/gi, '')}` : '';
  if (task.pollCount >= pollsNeeded) {
    task.status = 'succeed';
    const urlBase = `http://${HOST}:${PORT}/files/${id}${modelTag}`;
    if (task.kind === 'video') {
      return {
        task_status: 'succeed',
        task_result: {
          works: [
            { url: `${urlBase}.mp4`, type: 'video' },
          ],
        },
      };
    }
    return {
      task_status: 'succeed',
      task_result: {
        works: [
          { url: `${urlBase}.png`, type: 'image' },
          { url: `${urlBase}_2.png`, type: 'image' },
        ],
      },
    };
  }
  return { task_status: 'processing', task_result: null };
}

function handleToolCall(params) {
  const { name, arguments: args = {} } = params;
  switch (name) {
    case 'who_am_i':
      return {
        content: [{ type: 'text', text: JSON.stringify({ user: 'mock-user@kling.test', plan: 'pro', credits: 9999, mcpVersion: '1.3.3', availableModels: AVAILABLE_MODELS }) }],
      };
    case 'text_to_image':
    case 'image_to_image':
    case 'text_to_video':
    case 'image_to_video': {
      // Envelope Kling: parse dulu, lalu validasi flat hasilnya.
      const flat = parseEnvelope(args);
      const modelError = requireModel(name, flat);
      if (modelError) {
        return { content: [{ type: 'text', text: modelError }], isError: true };
      }
      if (!flat.prompt && name !== 'image_to_video') {
        return { content: [{ type: 'text', text: "Missing required argument(s): prompt. Call who_am_i for this model's argument specification." }], isError: true };
      }
      const spec = AVAILABLE_MODELS[name].models.find((m) => m.model === flat.model);
      const requiredInputs = (spec?.inputs ?? []).filter((i) => i.required).map((i) => i.name);
      for (const req of requiredInputs) {
        if (!flat.__inputUrls[req]) {
          return { content: [{ type: 'text', text: `Missing required input(s): ${req}.` }], isError: true };
        }
      }
      const id = nextId();
      const kind = name.includes('video') ? 'video' : 'image';
      tasks.set(id, { kind, status: 'submitted', createdAt: Date.now(), pollCount: 0, args: flat });
      // Respons submit: gaya Kling — text JSON dgn generation_id + task_status.
      return {
        content: [{ type: 'text', text: JSON.stringify({ generation_id: id, task_status: 'submitted' }) }],
      };
    }
    case 'query_tasks': {
      const id = String(args.generation_id ?? '');
      const task = tasks.get(id);
      if (!task) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'task not found' }) }], isError: true };
      }
      task.pollCount += 1;
      const result = taskResult(task, id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ generation_id: id, ...result }) }],
      };
    }
    case 'element_list':
      return {
        content: [{ type: 'text', text: JSON.stringify({ elements: [{ id: 'el_1', name: 'Character A' }, { id: 'el_2', name: 'Scene B' }] }) }],
      };
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

/* ── HTTP server ─────────────────────────────────────────────────────── */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── File aset tiruan (untuk /v1/videos/:id/content proxy test) ──
  if (url.pathname.startsWith('/files/')) {
    const isVideo = url.pathname.endsWith('.mp4');
    const fake = Buffer.from(isVideo ? `FAKE_MP4_${url.pathname}` : `FAKE_PNG_${url.pathname}`);
    res.writeHead(200, {
      'Content-Type': isVideo ? 'video/mp4' : 'image/png',
      'Content-Length': fake.length,
    });
    res.end(fake);
    return;
  }

  // ── OAuth discovery (RFC 9728 + 8414) ──
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    sendJson(res, 200, {
      resource: `http://${HOST}:${PORT}/mcp`,
      authorization_servers: [`http://${HOST}:${PORT}`],
    });
    return;
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    sendJson(res, 200, {
      issuer: `http://${HOST}:${PORT}`,
      authorization_endpoint: `http://${HOST}:${PORT}/oauth/authorize`,
      token_endpoint: `http://${HOST}:${PORT}/oauth/token`,
      registration_endpoint: `http://${HOST}:${PORT}/oauth/register`,
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
    });
    return;
  }

  // ── Dynamic client registration (RFC 7591) ──
  if (url.pathname === '/oauth/register' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const clientId = `client_${randomBytes(8).toString('hex')}`;
    clients.set(clientId, { redirect_uris: body.redirect_uris ?? [] });
    sendJson(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
    return;
  }

  // ── Authorization endpoint: auto-approve (mock) ──
  if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state') ?? '';
    const codeChallenge = url.searchParams.get('code_challenge') ?? '';
    if (!clients.has(clientId)) {
      sendJson(res, 400, { error: 'invalid_client' });
      return;
    }
    const code = `code_${randomBytes(10).toString('hex')}`;
    authCodes.set(code, { clientId, redirectUri, codeChallenge });
    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', state);
    res.writeHead(302, { Location: redirect.href });
    res.end();
    return;
  }

  // ── Token endpoint (authorization_code + refresh_token, PKCE S256) ──
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') {
      const code = form.get('code');
      const clientId = form.get('client_id');
      const codeVerifier = form.get('code_verifier');
      const stored = authCodes.get(code);
      if (!stored || stored.clientId !== clientId) {
        sendJson(res, 400, { error: 'invalid_grant' });
        return;
      }
      const expected = b64url(createHash('sha256').update(codeVerifier).digest());
      if (expected !== stored.codeChallenge) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      authCodes.delete(code);
      const accessToken = `at_${randomBytes(16).toString('hex')}`;
      const refreshToken = `rt_${randomBytes(16).toString('hex')}`;
      accessTokens.set(accessToken, { refreshToken });
      refreshTokens.set(refreshToken, {});
      sendJson(res, 200, {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp',
      });
      return;
    }
    if (grantType === 'refresh_token') {
      const refreshToken = form.get('refresh_token');
      if (!refreshTokens.has(refreshToken)) {
        sendJson(res, 400, { error: 'invalid_grant' });
        return;
      }
      refreshTokens.delete(refreshToken);
      const accessToken = `at_${randomBytes(16).toString('hex')}`;
      const newRefresh = `rt_${randomBytes(16).toString('hex')}`;
      accessTokens.set(accessToken, { refreshToken: newRefresh });
      refreshTokens.set(newRefresh, {});
      sendJson(res, 200, {
        access_token: accessToken,
        refresh_token: newRefresh,
        token_type: 'Bearer',
        expires_in: 3600,
      });
      return;
    }
    sendJson(res, 400, { error: 'unsupported_grant_type' });
    return;
  }

  // ── MCP endpoint (Streamable HTTP) ──
  if (url.pathname === '/mcp' && req.method === 'POST') {
    // Auth: Bearer token WAJIB (layaknya Kling OAuth).
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || !accessTokens.has(token)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: missing/invalid Bearer token' } });
      return;
    }

    const bodyText = await readBody(req);
    let msg;
    try {
      msg = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && !sessions.has(sessionId)) {
      // Session expired → 404 sesuai spec (menguji retry client).
      sendJson(res, 404, { error: 'Session expired' });
      return;
    }

    // Notification (no id) → 202.
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === 'notifications/initialized' && sessionId) {
        sessions.get(sessionId).initialized = true;
      }
      res.writeHead(202);
      res.end();
      return;
    }

    const reply = (resultOrError, viaSse = false) => {
      const message = { jsonrpc: '2.0', id: msg.id, ...(resultOrError.error ? { error: resultOrError.error } : { result: resultOrError.result }) };
      const headers = {};
      if (!sessionId) {
        const sid = newSessionId(msg);
        if (sid) headers['Mcp-Session-Id'] = sid;
      }
      if (viaSse) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...headers });
        res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
        res.write(`event: ping\ndata: {}\n\n`);
        res.end();
      } else {
        sendJson(res, 200, message, headers);
      }
    };

    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        if (requested !== '2025-06-18' && requested !== '2025-03-26') {
          reply({ error: { code: -32600, message: `Unsupported protocol version: ${requested}` } });
          return;
        }
        reply({
          result: {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'kling-mock', version: '1.0.0' },
          },
        });
        return;
      }
      case 'tools/list': {
        // Kirim via SSE supaya parser SSE SiberGate teruji.
        reply({ result: { tools: TOOLS } }, true);
        return;
      }
      case 'tools/call': {
        const result = handleToolCall(msg.params ?? {});
        // tools/call balas JSON biasa (campuran JSON+SSE realistis).
        reply({ result });
        return;
      }
      default:
        reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
    return;
  }

  // DELETE session (spec) — diabaikan mock.
  if (url.pathname === '/mcp' && req.method === 'DELETE') {
    res.writeHead(405);
    res.end();
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

/** Session id baru dibuat saat initialize (belum ada header session). */
function newSessionId(msg) {
  if (msg.method !== 'initialize') return undefined;
  const id = `sess_${randomBytes(8).toString('hex')}`;
  sessions.set(id, { initialized: false });
  return id;
}

server.listen(PORT, HOST, () => {
  console.log(`Mock MCP server (Kling-style) listening on http://${HOST}:${PORT}`);
  console.log(`  MCP endpoint : http://${HOST}:${PORT}/mcp  (Bearer token via OAuth)`);
  console.log(`  OAuth flow   : http://${HOST}:${PORT}/.well-known/oauth-protected-resource`);
  console.log(`  Auto-approve : authorize endpoint langsung redirect (tanpa login page)`);
});
