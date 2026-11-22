/**
 * Setup / refresh route speech "python-qwen" — Qwen TTS PROVIDER-NATIVE.
 *
 * Pendekatan sama dengan image generation (mapping='auto'): klien mengirim
 * body standar OpenAI /v1/audio/speech, gateway menerjemahkannya ke dialek
 * native DashScope SpeechSynthesizer (speech-mapper.ts) dan mengembalikan
 * binary audio. TIDAK memakai custom script / loopback lagi.
 *
 * Yang dilakukan (idempotent, aman dijalankan ulang):
 *   1. Perbaiki endpoint speech provider qwencloud → REST SpeechSynthesizer
 *      (path /api/v1/services/audio/tts/SpeechSynthesizer).
 *   2. Daftarkan model TTS (default qwencloud/qwen-audio-3.0-tts-flash).
 *   3. Route speech 'python-qwen' → target provider itu dengan mapping='auto'
 *      (+ key spesifik bila --credential-key diberikan).
 *   4. Bersihkan artefak pendekatan lama: provider/model loopback
 *      'python-qwen', custom script 'python-qwen', key loopback-nya.
 *
 * Usage:
 *   npm run build:core && npx tsx scripts/setup-python-qwen-tts.ts \
 *     [--provider qwencloud] [--model qwen-audio-3.0-tts-flash] \
 *     [--route python-qwen] [--credential-key <provider_keys.id>] \
 *     [--keep-legacy]
 *
 * Gateway sebaiknya di-restart / reload setelah ini (config di-cache).
 * Jangan commit API key: script ini tidak pernah mencetak nilai key.
 */
import {
  admin,
  deleteScript,
  getDb,
  getScript,
  loadConfigFromDb,
  loadDotEnv,
} from '@sibergate/core';

const SPEECH_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function main(): void {
  loadDotEnv();
  getDb(); // buka + migrasi schema

  const providerId = arg('provider', 'qwencloud');
  const modelName = arg('model', 'qwen-audio-3.0-tts-flash');
  const routeId = arg('route', 'python-qwen');
  const credentialKeyId = arg('credential-key', '');
  const keepLegacy = process.argv.includes('--keep-legacy');
  const modelId = `${providerId}/${modelName}`;

  // 1. Provider: pastikan endpoint speech = REST SpeechSynthesizer.
  const provider = admin.getProvider(providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' tidak ditemukan. Buat dulu di admin (Providers) dengan API key akun Qwen Cloud.`);
  }
  const endpoints = { ...((provider.endpoints as Record<string, string>) ?? {}) };
  if (endpoints.speech !== SPEECH_PATH) {
    admin.updateProvider(providerId, { endpoints: { ...endpoints, speech: SPEECH_PATH } });
    console.log(`✓ provider '${providerId}' endpoint speech → ${SPEECH_PATH}`);
  } else {
    console.log(`• provider '${providerId}' endpoint speech sudah benar`);
  }

  // Validasi credential: route target tanpa key memakai key default provider.
  const config = loadConfigFromDb();
  const keys = config.providerKeys.filter((k) => k.providerId === providerId && k.enabled && k.value);
  if (credentialKeyId && !keys.some((k) => k.id === credentialKeyId)) {
    throw new Error(`Key '${credentialKeyId}' tidak ditemukan/enabled/berisi untuk provider '${providerId}'.`);
  }
  if (!credentialKeyId && keys.length === 0) {
    console.warn(`⚠ provider '${providerId}' belum punya API key berisi — tambahkan di admin (Providers → Keys) sebelum uji.`);
  }

  // 2. Model TTS.
  admin.upsertModel({
    id: modelId,
    provider: providerId,
    displayName: modelName,
    modalities: ['audio'],
    enabled: true,
  });
  console.log(`✓ model '${modelId}' terdaftar (modality audio)`);

  // 3. Route speech native (mapping auto = terjemahkan OpenAI ⇄ DashScope).
  admin.upsertRoute({
    id: routeId,
    name: 'Python Qwen TTS',
    modality: 'speech',
    strategy: 'fallback',
    timeoutMs: 120_000,
    targets: [{
      provider: providerId,
      model: modelId,
      priority: 0,
      weight: 1,
      mapping: 'auto',
      ...(credentialKeyId ? { key: credentialKeyId } : {}),
    }],
  });
  console.log(`✓ route speech '${routeId}' → ${modelId} (mapping=auto${credentialKeyId ? `, key ${credentialKeyId}` : ', key default provider'})`);

  // 4. Bersihkan artefak pendekatan custom-script lama (loopback ke gateway).
  if (!keepLegacy && routeId !== 'python-qwen' ? false : !keepLegacy) {
    const db = getDb();
    const legacyProvider = admin.getProvider('python-qwen');
    const legacyIsLoopback = legacyProvider && /127\.0\.0\.1|localhost/.test(String(legacyProvider.baseUrl ?? ''));
    if (legacyIsLoopback && providerId !== 'python-qwen') {
      // Lepas dulu target route lama yg menunjuk provider loopback (bila route
      // utama bukan 'python-qwen', route itu tetap ada — hapus targetnya saja).
      if (routeId !== 'python-qwen') {
        const row = admin.getRouteRow(routeId) as { targets?: Array<{ provider: string }> } | null;
        const targets = (row?.targets ?? []).filter((t) => t.provider !== 'python-qwen');
        admin.upsertRoute({ id: routeId, targets: targets as never });
      }
      db.prepare('DELETE FROM models WHERE provider_id = ?').run('python-qwen');
      db.prepare('DELETE FROM provider_keys WHERE provider_id = ?').run('python-qwen');
      admin.deleteProvider('python-qwen');
      console.log(`✓ provider loopback lama 'python-qwen' + model + key dihapus`);
    }
    if (getScript('python-qwen')) {
      deleteScript('python-qwen');
      console.log(`✓ custom script lama 'python-qwen' dihapus (tidak dipakai lagi)`);
    }
  }

  console.log('\nSelesai. Restart gateway, lalu uji:');
  console.log(`  curl -X POST http://127.0.0.1:${process.env.SIBERGATE_PORT ?? '8787'}/v1/audio/speech \\`);
  console.log(`    -H "Authorization: Bearer <client key>" -H 'Content-Type: application/json' \\`);
  console.log(`    -d '{"model":"${routeId}","input":"Halo dari Qwen TTS","voice":"longanfengyue","response_format":"mp3"}' \\`);
  console.log(`    --output out.mp3`);
}

try {
  main();
} catch (err) {
  console.error('[setup-python-qwen-tts] gagal:', err instanceof Error ? err.message : err);
  process.exit(1);
}