// pocket-tts-worker.js
// Pocket TTS Web Worker for StoryTap
// Handles WASM model loading and audio generation off the main thread.
// Based on https://github.com/LaurentMazare/xn/tree/main/wasm-pocket-tts (MIT License)

import init, { Model } from 'https://laurentmazare.github.io/pocket-tts/wasm_pocket_tts.js';

const WASM_URL = 'https://laurentmazare.github.io/pocket-tts/wasm_pocket_tts_bg.wasm';
const HF_BASE = 'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main';
const MODEL_URL = `${HF_BASE}/tts_b6369a24.safetensors`;
const TOKENIZER_URL = `${HF_BASE}/tokenizer.model`;

function voiceUrl(name) {
  return `${HF_BASE}/embeddings_v2/${name}.safetensors`;
}

function post(type, data = {}, transferables = []) {
  self.postMessage({ type, ...data }, transferables);
}

async function fetchWithProgress(url, label) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) {
      const pct = Math.round(received / total * 100);
      post('progress', { label, pct, detail: `${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB` });
    } else {
      post('progress', { label, pct: -1, detail: `${(received / 1e6).toFixed(1)} MB` });
    }
  }
  const buf = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
  return buf;
}

// ---- Minimal protobuf decoder for sentencepiece .model files ----
// Ported from https://github.com/LaurentMazare/xn/blob/main/wasm-pocket-tts/worker.js
function decodeSentencepieceModel(buffer) {
  let pos = 0;

  function readVarint() {
    let result = 0, shift = 0;
    while (pos < buffer.length) {
      const b = buffer[pos++];
      result |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) return result;
    }
    return result;
  }

  function readBytes(n) {
    const data = buffer.slice(pos, pos + n);
    pos += n;
    return data;
  }

  function readVarIntFrom(buf, p) {
    let result = 0, shift = 0;
    while (p < buf.length) {
      const b = buf[p++];
      result |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) return { val: result, pos: p };
    }
    return { val: result, pos: p };
  }

  function decodePiece(data) {
    let pPos = 0, piece = '', score = 0, type = 1;
    const pView = new DataView(data.buffer, data.byteOffset, data.byteLength);
    while (pPos < data.length) {
      const key = readVarIntFrom(data, pPos);
      pPos = key.pos;
      const fieldNum = key.val >>> 3;
      const wireType = key.val & 0x7;
      if (fieldNum === 1 && wireType === 2) {
        const len = readVarIntFrom(data, pPos);
        pPos = len.pos;
        piece = new TextDecoder().decode(data.slice(pPos, pPos + len.val));
        pPos += len.val;
      } else if (fieldNum === 2 && wireType === 5) {
        score = pView.getFloat32(pPos, true);
        pPos += 4;
      } else if (fieldNum === 3 && wireType === 0) {
        const v = readVarIntFrom(data, pPos);
        type = v.val;
        pPos = v.pos;
      } else {
        if (wireType === 0) { const v = readVarIntFrom(data, pPos); pPos = v.pos; }
        else if (wireType === 1) { pPos += 8; }
        else if (wireType === 2) { const len = readVarIntFrom(data, pPos); pPos = len.pos + len.val; }
        else if (wireType === 5) { pPos += 4; }
        else break;
      }
    }
    return { piece, score, type };
  }

  const pieces = [];
  while (pos < buffer.length) {
    const key = readVarint();
    const fieldNum = key >>> 3;
    const wireType = key & 0x7;
    if (fieldNum === 1 && wireType === 2) {
      const len = readVarint();
      const data = readBytes(len);
      pieces.push(decodePiece(data));
    } else {
      if (wireType === 0) { readVarint(); }
      else if (wireType === 1) { pos += 8; }
      else if (wireType === 2) { const len = readVarint(); pos += len; }
      else if (wireType === 5) { pos += 4; }
      else break;
    }
  }
  return pieces;
}

// ---- Unigram SentencePiece tokenizer (Viterbi) ----
class UnigramTokenizer {
  constructor(pieces) {
    this.pieces = pieces;
    this.vocab = new Map();
    this.unkId = 0;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.type === 2) this.unkId = i;
      if (p.type === 1 || p.type === 4) this.vocab.set(p.piece, { id: i, score: p.score });
      if (p.type === 6) this.vocab.set(p.piece, { id: i, score: p.score });
    }
  }

  encode(text) {
    const normalized = '\u2581' + text.replace(/ /g, '\u2581');
    return this._viterbi(normalized);
  }

  _viterbi(text) {
    const n = text.length;
    const best = new Array(n + 1);
    best[0] = { score: 0, len: 0, id: -1 };
    for (let i = 1; i <= n; i++) best[i] = { score: -Infinity, len: 0, id: -1 };

    for (let i = 0; i < n; i++) {
      if (best[i].score === -Infinity) continue;
      for (let len = 1; len <= n - i && len <= 64; len++) {
        const sub = text.substring(i, i + len);
        const entry = this.vocab.get(sub);
        if (entry) {
          const newScore = best[i].score + entry.score;
          if (newScore > best[i + len].score) {
            best[i + len] = { score: newScore, len, id: entry.id };
          }
        }
      }
      if (best[i + 1].score === -Infinity) {
        const ch = text.charCodeAt(i);
        const byteStr = `<0x${ch.toString(16).toUpperCase().padStart(2, '0')}>`;
        const byteEntry = this.vocab.get(byteStr);
        const fallbackId = byteEntry ? byteEntry.id : this.unkId;
        const fallbackScore = byteEntry ? byteEntry.score : -100;
        best[i + 1] = { score: best[i].score + fallbackScore, len: 1, id: fallbackId };
      }
    }

    const ids = [];
    let p = n;
    while (p > 0) { ids.push(best[p].id); p -= best[p].len; }
    ids.reverse();
    return new Uint32Array(ids);
  }
}

// ---- WAV encoder ----
function encodeWav(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = samples.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE'); writeString(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true); writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(offset, s, true);
    offset += 2;
  }
  return buffer;
}

// ---- Worker state ----
let model = null;
let tokenizer = null;
const voiceIndexMap = {};

async function handleLoad(defaultVoice) {
  post('status', { message: 'Initializing voice engine...' });

  // Start WASM compilation immediately
  const wasmModulePromise = WebAssembly.compileStreaming(fetch(WASM_URL));

  // Load tokenizer while WASM compiles
  post('status', { message: 'Loading tokenizer...' });
  const tokData = await fetchWithProgress(TOKENIZER_URL, 'Tokenizer');
  const pieces = decodeSentencepieceModel(tokData);
  tokenizer = new UnigramTokenizer(pieces);
  post('progress', { label: 'Engine', pct: 5, detail: `Tokenizer ready (${pieces.length} pieces)` });

  // Await WASM compilation and init
  post('status', { message: 'Preparing voice engine...' });
  const wasmModule = await wasmModulePromise;
  await init(wasmModule);
  post('progress', { label: 'Engine', pct: 10, detail: 'WASM ready' });

  // Load model weights (~240MB, browser caches after first load)
  post('status', { message: 'Downloading voice model (240MB, cached after first use)...' });
  const modelWeights = await fetchWithProgress(MODEL_URL, 'Voice model');

  post('status', { message: 'Initializing model...' });
  model = new Model(modelWeights);
  post('progress', { label: 'Engine', pct: 98, detail: 'Model ready' });

  // Preload the default voice
  if (defaultVoice) {
    await handleLoadVoice(defaultVoice);
  }

  post('loaded', { sampleRate: 24000 });
}

async function handleLoadVoice(name) {
  if (voiceIndexMap[name] !== undefined) return;
  post('status', { message: `Loading voice: ${name}...` });
  const voiceData = await fetchWithProgress(voiceUrl(name), `Voice: ${name}`);
  voiceIndexMap[name] = model.add_voice(voiceData);
  post('voice_loaded', { name, index: voiceIndexMap[name] });
}

async function handleGenerate(text, voiceName, id) {
  // Ensure voice is loaded (lazy load on first use)
  await handleLoadVoice(voiceName);

  const voiceIndex = voiceIndexMap[voiceName];
  const [processedText, framesAfterEos] = model.prepare_text(text);
  const tokenIds = tokenizer.encode(processedText);

  // Temperature 0.7 with fixed seed=42 (deterministic — safe for caching)
  model.start_generation(voiceIndex, tokenIds, framesAfterEos, 0.7);

  const chunks = [];
  while (true) {
    const chunk = model.generation_step();
    if (!chunk) break;
    chunks.push(chunk);
  }

  // Concatenate all audio chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const allPcm = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) { allPcm.set(chunk, offset); offset += chunk.length; }

  const wavBuffer = encodeWav(allPcm, 24000);
  post('audio_complete', { wavData: wavBuffer, id }, [wavBuffer]);
}

self.onmessage = async (e) => {
  const { type, ...data } = e.data;
  try {
    if (type === 'load') {
      await handleLoad(data.voice);
    } else if (type === 'load_voice') {
      await handleLoadVoice(data.name);
    } else if (type === 'generate') {
      await handleGenerate(data.text, data.voice, data.id);
    }
  } catch (err) {
    post('error', { message: err.message, id: data.id });
    console.error('[PocketTTS Worker]', err);
  }
};
