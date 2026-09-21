// v2-demo.js — the V2 validation demo app (spec: docs/research/2026-09-19-v2-demo-design.md v2)
//
// ONE page that boots the real Tracktion engine (wasm + AudioWorklet), builds
// a musical 8-bar arrangement live, and lets the owner play it, tweak every
// E1-E4 surface, and run a measured verification suite. Every control maps
// 1:1 to a real engine export. No frameworks, no build step.
//
// Sections: 0 constants/utils · 1 asset synthesis · 2 protocol layer ·
// 3 state+boot+build · 4 UI · 5 verify suite · 6 __demo hooks.
'use strict';

/* ═════════════════════ SECTION 0 · constants + utils ═════════════════════ */

const SAMPLE_RATE = 48000;
const BPM = 100;
const SEC_PER_BEAT = 60 / BPM;          // 0.6 s
const BARS = 8;
const TOTAL_BEATS = BARS * 4;           // 32
const TOTAL_SEC = TOTAL_BEATS * SEC_PER_BEAT; // 19.2 s

const T = { DRUMS: 0, KEYS: 1, BASS: 2, BUS: 3 };   // the EXPECTED layout (captured from replies; Drums is a FRESH track — the seeded track 0 stays unused)
const DRUMS = () => (state.trackIds ? state.trackIds.Drums : 0);   // the drums trackId (dynamic)
const AU = { trackId: 1, pluginIdx: 0, paramId: 'Low-pass gain' }; // the automation target (exit-proven)

// fixed-seed LCG — deterministic "randomness" for asset synthesis
let _lcgS = 0x2F6E2B1;
function lcg() { _lcgS = (_lcgS * 1664525 + 1013904223) >>> 0; return _lcgS / 4294967296; }

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbToLin = (db) => Math.pow(10, db / 20);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// the music (E minor, 100 BPM) — chords as whole-bar pads, a sparse top
// melody in bars 5-8, and a root+fifth bassline.
const CHORDS = [ // one per bar: Em, C, G, D ×2
  [52, 59, 64, 67], [55, 60, 64, 67], [55, 59, 62, 67], [50, 57, 62, 66],
  [52, 59, 64, 67], [55, 60, 64, 67], [55, 59, 62, 67], [50, 57, 62, 66],
];
const MELODY = [ // [beat, pitch, beats] — sparse, over bars 5-8
  [16, 76, 1.5], [17.5, 74, 0.5], [18, 71, 2], [20, 74, 1.5], [21.5, 76, 0.5],
  [22, 79, 2], [24, 76, 1.5], [25.5, 74, 0.5], [26, 71, 2], [28, 74, 1],
  [29, 76, 1], [30, 79, 2],
];
const BASSLINE = []; // built per bar: root (3 beats) + fifth (1 beat)
{
  const ROOTS = [40, 36, 43, 38];       // E2, C2, G2, D2
  const FIFTHS = [47, 43, 50, 45];      // B2, G3, D3, A2
  for (let bar = 0; bar < BARS; bar++) {
    const i = bar % 4;
    BASSLINE.push([bar * 4 + 0, ROOTS[i], 2.5]);
    BASSLINE.push([bar * 4 + 3, FIFTHS[i], 1]);
  }
}

/* ═════════════════════ SECTION 1 · asset synthesis (spec §5) ═════════════ */

// ---- 1.1 the EP timbre: partials with exp decay, soft attack, detune ----
function synthEPNote(hz, durSec) {
  const n = Math.floor(durSec * SAMPLE_RATE);
  const out = new Float32Array(n);
  const partials = [
    { mul: 1.0, db: 0, tau: 0.45 }, { mul: 2.0, db: -8, tau: 0.32 },
    { mul: 3.01, db: -16, tau: 0.24 }, { mul: 4.02, db: -24, tau: 0.18 },
  ];
  for (const p of partials) {
    const amp = Math.pow(10, p.db / 20);
    const detune = 1 + (lcg() - 0.5) * 0.0023;  // ±2 cents
    const w = 2 * Math.PI * hz * p.mul * detune / SAMPLE_RATE;
    const att = Math.floor(0.015 * SAMPLE_RATE);
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-i / (p.tau * SAMPLE_RATE));
      const a = i < att ? i / att : 1;
      out[i] += amp * env * a * Math.sin(w * i + lcg() * 0.01);
    }
  }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  if (pk > 0) for (let i = 0; i < n; i++) out[i] *= 0.8 / pk;
  return out;
}

// ---- 1.2 the BASS timbre: sine + 2nd/3rd harmonics, slow attack ----
function synthBassNote(hz, durSec) {
  const n = Math.floor(durSec * SAMPLE_RATE);
  const out = new Float32Array(n);
  const partials = [
    { mul: 1.0, db: 0, tau: 0.8 }, { mul: 2.0, db: -10, tau: 0.6 },
    { mul: 3.0, db: -20, tau: 0.45 },
  ];
  const att = Math.floor(0.025 * SAMPLE_RATE);
  for (const p of partials) {
    const amp = Math.pow(10, p.db / 20);
    const w = 2 * Math.PI * hz * p.mul / SAMPLE_RATE;
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-i / (p.tau * SAMPLE_RATE));
      const a = i < att ? i / att : 1;
      out[i] += amp * env * a * Math.sin(w * i);
    }
  }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  if (pk > 0) for (let i = 0; i < n; i++) out[i] *= 0.8 / pk;
  return out;
}

// build the sample tables: EP one per 4 semitones (MIDI 48..84), BASS at 28/33/40/45
function buildEPSamples() {
  const samples = [];
  for (let k = 48; k <= 84; k += 4) samples.push({ key: k, pcm: synthEPNote(midiHz(k), 1.6) });
  return samples;
}
function buildBassSamples() {
  return [28, 33, 40, 45].map((k) => ({ key: k, pcm: synthBassNote(midiHz(k), 1.4) }));
}

// tile lokey/hikey regions across the keyboard for a set of keycentered
// samples — MIDPOINT boundaries (no gaps: a note in a gap is silent; no
// overlaps: sfizz fires ALL matching regions = doubled voices)
function buildSfzText(samples, veltrack) {
  const lines = ['<control> default_path='];
  for (let i = 0; i < samples.length; i++) {
    const k = samples[i].key;
    const lo = i === 0 ? 21 : Math.floor((samples[i - 1].key + k) / 2) + 1;
    const hi = i === samples.length - 1 ? 108 : Math.floor((k + samples[i + 1].key) / 2);
    lines.push(`<region> sample=${samples[i].name} lokey=${lo} hikey=${hi} ` +
      `pitch_keycenter=${k} amp_veltrack=${veltrack}`);
  }
  return lines.join('\n');
}

// ---- 1.3 the drum groove: 4 sections × 2 bars, stereo, per §5.3 ----
function synthKick(n0, outL, outR) {
  const dur = Math.floor(0.15 * SAMPLE_RATE);
  const f0 = 65, f1 = 42, att = 32;
  for (let i = 0; i < dur && n0 + i < outL.length; i++) {
    const t = i / SAMPLE_RATE;
    const f = f1 + (f0 - f1) * Math.exp(-t / 0.03);
    const env = Math.exp(-t / 0.055) * (i < att ? i / att : 1);
    const v = Math.sin(2 * Math.PI * f * t) * env * 1.0;
    outL[n0 + i] += v; outR[n0 + i] += v;
  }
  for (let i = 0; i < Math.floor(0.003 * SAMPLE_RATE); i++) { // click
    const v = (lcg() * 2 - 1) * 0.25 * Math.exp(-i / (0.001 * SAMPLE_RATE));
    outL[n0 + i] += v; outR[n0 + i] += v;
  }
}
function synthSnare(n0, outL, outR, amp = 1.0) {
  const dur = Math.floor(0.18 * SAMPLE_RATE);
  const wn = Math.floor(0.12 * SAMPLE_RATE);
  let lpz = 0;
  for (let i = 0; i < dur && n0 + i < outL.length; i++) {
    const t = i / SAMPLE_RATE;
    const tone = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.03) * 0.5;
    const nz = i < wn ? (lcg() * 2 - 1) * Math.exp(-t / 0.045) * 0.8 : 0;
    lpz = lpz * 0.6 + nz * 0.4;                     // band-ish shaping
    const v = (tone + lpz) * amp;
    outL[n0 + i] += v * 0.95; outR[n0 + i] += v * 1.05;
  }
}
function synthHat(n0, outL, outR, open, amp = 1.0) {
  const dur = Math.floor((open ? 0.3 : 0.07) * SAMPLE_RATE);
  let hp = 0, prev = 0;
  for (let i = 0; i < dur && n0 + i < outL.length; i++) {
    const t = i / SAMPLE_RATE;
    const x = (lcg() * 2 - 1) * Math.exp(-t / (open ? 0.12 : 0.025));
    hp = x - prev + hp * 0.72; prev = x;             // crude 6k-ish HPF
    const v = hp * 0.5 * amp;
    outL[n0 + i] += v * 0.9; outR[n0 + i] += v * 1.1;
  }
}
// one 2-bar stereo section (planar [L frames..., R frames...])
function synthDrumSection(sectionIdx) {
  const n = Math.floor(2 * 4 * SEC_PER_BEAT * SAMPLE_RATE); // 2 bars
  const L = new Float32Array(n), R = new Float32Array(n);
  const at = (beat) => Math.floor(beat * SEC_PER_BEAT * SAMPLE_RATE);
  const bars2 = [0, 1];                               // section-local bars
  for (const b of bars2) {
    const bb = b * 4;                                 // local beat base
    synthKick(at(bb + 0), L, R);
    synthKick(at(bb + 2), L, R);
    if (b === 1) synthKick(at(bb + 2.75), L, R);      // syncopation bar 2
    synthSnare(at(bb + 1), L, R);
    synthSnare(at(bb + 3), L, R);
    for (let e = 0; e < 8; e++) {
      const open = e === 7 && b === 1;
      const acc = e % 2 === 1 ? 1.0 : 0.62;
      synthHat(at(bb + e * 0.5), L, R, open, acc);
    }
  }
  if (sectionIdx === 3) {                             // the fill: last half-bar 16th snares
    for (let i = 0; i < 8; i++)
      synthSnare(at(4 + 2 + i * 0.25), L, R, 0.5 + i * 0.06);
  }
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  const g = pk > 0 ? 0.9 / pk : 1;
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  const planar = new Float32Array(n * 2);
  planar.set(L, 0); planar.set(R, n);
  return { pcm: planar, frames: n, chans: 2 };
}

// ---- 1.4 the IR: e^(-t/0.35) * (0.6 + 0.4 cos(2pi*90t)), R +7ms ----
function buildIRWav() {
  const n = Math.floor(2.2 * SAMPLE_RATE);
  const L = new Float32Array(n), R = new Float32Array(n);
  const dR = Math.floor(0.007 * SAMPLE_RATE);
  let pk = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t / 0.35);
    const col = 0.6 + 0.4 * Math.cos(2 * Math.PI * 90 * t);
    L[i] = env * col;
    R[i] = (i >= dR ? env * col : 0);       // R delayed 7 ms for width
    pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  }
  // UNITY PEAK (not unity energy — an energy-normalized 2.2 s exponential
  // IR peaks at ~2.4× = +7.6 dB of bus gain; peak is the audio-standard)
  const g = pk > 0 ? 1.0 / pk : 1;
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  return encodeWavPCM16([L, R], SAMPLE_RATE);
}

// ---- 1.5 the stretch-test sine: 440 Hz, 2 s, mono, 0.5 peak ----
function buildSineAsset() {
  const n = Math.floor(2.0 * SAMPLE_RATE);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE);
  return { pcm, frames: n, chans: 1 };
}

// ---- 1.6 a PCM16 RIFF WAV encoder (the ir-load-data + download contract) ----
function encodeWavPCM16(channels, rate) {
  const numCh = channels.length, n = channels[0].length;
  const dataBytes = numCh * n * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const wtag = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wtag(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); wtag(8, 'WAVE');
  wtag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, numCh, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * numCh * 2, true); dv.setUint16(32, numCh * 2, true);
  dv.setUint16(34, 16, true);
  wtag(36, 'data'); dv.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < numCh; c++) {
      const s = clamp(channels[c][i], -1, 1);
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2;
    }
  return buf;
}

/* ═════════════════════ SECTION 2 · the protocol layer ════════════════════ */

let audioCtx = null, workletNode = null, analyser = null, fftBuf = null;
let engineReady = false, built = false;
const waiters = [];          // {pred, resolve, timer}
const warnList = [];
let pumpTimer = null;

const streamHandlers = {     // reply types consumed as STREAMS (never waitFor'd)
  position: [], trackLevel: [], masterLevel: [], warn: [], error: [],
};
function onStream(kind, fn) { (streamHandlers[kind] || []).push(fn); }

function post(msg, transfer) {
  if (!workletNode) return;
  if (transfer && transfer.length) workletNode.port.postMessage(msg, transfer);
  else workletNode.port.postMessage(msg);
}

function waitFor(typeOrPred, ms = 8000, match = null) {
  const pred = typeof typeOrPred === 'function'
    ? typeOrPred : (r) => r.type === typeOrPred && (!match || match(r));
  return new Promise((resolve) => {
    const w = { pred, resolve, done: false };
    w.timer = setTimeout(() => {
      if (w.done) return; w.done = true;
      const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1);
      resolve(null);                       // timeout = null (never a hang)
    }, ms);
    waiters.push(w);
  });
}

function routeReply(r) {
  // streams first
  if (r.type === 'position') { for (const f of streamHandlers.position) f(r); return; }
  if (r.type === 'track-level') { for (const f of streamHandlers.trackLevel) f(r); return; }
  if (r.type === 'master-level') { for (const f of streamHandlers.masterLevel) f(r); return; }
  if (r.type === 'warn') { recordWarn(r.message); for (const f of streamHandlers.warn) f(r); return; }
  if (r.type === 'error') { recordWarn('ERROR: ' + r.error, true); for (const f of streamHandlers.error) f(r); return; }
  // then the waitFor queue
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (w.done) { waiters.splice(i, 1); continue; }
    if (w.pred(r)) {
      w.done = true; clearTimeout(w.timer); waiters.splice(i, 1); w.resolve(r); return;
    }
  }
}

function recordWarn(msg, isError = false) {
  warnList.push({ t: Date.now(), msg, isError });
  if (warnList.length > 300) warnList.shift();
  const cnt = $('warn-count'); if (cnt) cnt.textContent = String(warnList.length);
  const tail = $('warn-tail'); if (tail) tail.textContent = msg.slice(0, 160);
  const list = $('warn-list');
  if (list && !list.hidden) renderWarnList();
}
function renderWarnList() {
  const list = $('warn-list'); if (!list) return;
  list.innerHTML = '';
  for (const w of warnList.slice(-60)) {
    const d = document.createElement('div');
    d.className = 'warn-item' + (w.isError ? ' warn-error' : '');
    d.textContent = new Date(w.t).toLocaleTimeString() + '  ' + w.msg;
    list.appendChild(d);
  }
}

function startPump() {
  if (pumpTimer) clearInterval(pumpTimer);
  pumpTimer = setInterval(() => post({ type: 'pump' }), 100);
}

async function bootAudio() {
  if (engineReady) return true;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctor({ latencyHint: 'interactive', sampleRate: SAMPLE_RATE });
  await audioCtx.audioWorklet.addModule('wasm/phase5-processor.js');
  workletNode = new AudioWorkletNode(audioCtx, 'phase5-processor', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
  });
  workletNode.connect(analyser = audioCtx.createAnalyser());
  analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0;
  fftBuf = new Float32Array(analyser.frequencyBinCount);   // allocated HERE — bandEnergyDb needs it before any tab opens
  workletNode.connect(audioCtx.destination);
  workletNode.port.onmessage = (e) => routeReply(e.data);
  const wasmResp = await fetch('wasm/tracktion_engine_wasm.wasm', { cache: 'no-store' });
  const wasmBinary = await wasmResp.arrayBuffer();
  recordWarn(`wasm fetched (${(wasmBinary.byteLength / 1048576).toFixed(2)} MB)`);
  post({ type: 'init-wasm', wasmBinary, instrument: 'none', loadMelody: false, deferLiveInput: true });
  const ready = await waitFor('ready', 30000);
  if (!ready || ready.engineCreated !== true) {
    setStatus('failed', 'engine boot FAILED' + (ready ? '' : ' (timeout)'));
    return false;
  }
  engineReady = true;
  startPump();
  return true;
}

// Goertzel-style band energy on the AnalyserNode (the §6j discipline):
// mean power in a ±bw window around f, in dB, vs a NEIGHBOR band ≥25% away.
function bandEnergyDb(hz, bw = 14) {
  analyser.getFloatFrequencyData(fftBuf);
  const binHz = SAMPLE_RATE / analyser.fftSize;
  const read = (f) => {
    const b0 = Math.max(1, Math.floor((f - bw) / binHz)), b1 = Math.min(fftBuf.length - 1, Math.ceil((f + bw) / binHz));
    let s = 0, c = 0;
    for (let b = b0; b <= b1; b++) { const v = fftBuf[b]; if (isFinite(v)) { s += Math.pow(10, v / 10); c++; } }
    return c ? 10 * Math.log10(s / c) : -140;       // dBFS-ish (AnalyserNode Blackman window)
  };
  return { at: read(hz), neighbor: read(hz * 1.32), raw: read };
}

// windowed RMS over `ms` of live output (time domain), via getFloatTimeDomainData
function liveRmsDb(ms = 500) {
  const n = analyser.fftSize;
  const td = new Float32Array(n);
  const t0 = performance.now();
  let acc = 0, cnt = 0;
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      analyser.getFloatTimeDomainData(td);
      for (let i = 0; i < n; i++) acc += td[i] * td[i];
      cnt += n;
      if (performance.now() - t0 >= ms) {
        clearInterval(iv);
        const rms = cnt ? Math.sqrt(acc / cnt) : 0;
        resolve(20 * Math.log10(Math.max(rms, 1e-9)));
      }
    }, Math.min(120, ms / 4));
  });
}

function setStatus(kind, detail) {
  const pill = $('status-pill'), det = $('status-detail');
  if (pill) { pill.className = 'pill pill-' + kind; pill.textContent = kind; }
  if (det) det.textContent = detail || '';
}

/* ═════════════════════ SECTION 3 · state + boot + build ══════════════════ */

// the JS mirror (spec §7): every mutation goes engine-first, replies update.
const state = {
  tracks: [],             // {id, name, kind: 'audio'|'bus'|'folder'|'master'}
  waveClips: [],          // {trackId, clipIdx, itemId, name, start, length, srcLengthSec, gainDb, pan, pitch, speed}
  midi: {},               // trackId -> [{startBeat, lengthBeats, notes:[{pitch,velocity,startBeat,lengthBeats}]}]
  assets: {},             // name -> {pcm, frames, chans} (for the timeline drawing)
  folder: { folderId: 0, volumeDb: -6 },
  bus: { trackId: -1, sendIdx: { 1: 0 } },
  curve: { points: [], bypassed: false },
  selected: null,         // {trackId, clipIdx, kind: 'wave'|'midi'}
  playing: false,
  position: 0,
  verifyResults: {},
  lastAnalysis: null,
  bounce: { path: 'v2_demo_bounce.wav', bytes: null, stats: null },
};

// the built arrangement's expected shape (V1 asserts against this)
const EXPECT = {
  numTracks: 5, waveClipsT0: 4, midiClips: { 1: 1, 2: 1 },
  notes: { keys: CHORDS.reduce((s, c) => s + c.length, 0) + MELODY.length, bass: BASSLINE.length },
  epRegions: 10, bassRegions: 4, pluginsT1: 1, pluginsMaster: 1, pluginsBus: 1,
};

async function ask(type, payload, replyType, ms = 8000, match = null) {
  post(Object.assign({ type }, payload || {}));
  return waitFor(replyType, ms, match);
}

async function buildArrangement() {
  if (!engineReady) throw new Error('engine not ready');
  if (built) return { ok: true, already: true };
  setStatus('building', 'synthesizing assets…');

  // the engine's default edit is 120 BPM — set OUR tempo FIRST, before any
  // content exists (the E2d remap semantics: a later change moves MIDI vs
  // time-anchored wave content relative to each other)
  post({ type: 'set-bpm', bpm: BPM });
  await sleep(150);

  // -- assets (JS side) --
  const ep = buildEPSamples();               // 10 samples, keys 48..84
  const bass = buildBassSamples();           // 4 samples, keys 28/33/40/45
  ep.forEach((s, i) => { s.name = `ep_${s.key}`; state.assets[s.name] = { pcm: s.pcm, frames: s.pcm.length, chans: 1 }; });
  bass.forEach((s) => { s.name = `bass_${s.key}`; state.assets[s.name] = { pcm: s.pcm, frames: s.pcm.length, chans: 1 }; });
  const drumSections = [];
  for (let i = 0; i < 4; i++) {
    const d = synthDrumSection(i);
    const nm = `drums_${i}`;
    state.assets[nm] = d; drumSections.push(nm);
  }
  const irWav = buildIRWav();
  const sine = buildSineAsset();
  state.assets['test_sine'] = sine;

  // -- the track tree: Keys/Bass as folder children FIRST (IDs 1/2 — the
  // HTML's live-input options + the AU target pin them), then the bus (3),
  // then a FRESH Drums track (the seeded track 0 stays unused: its
  // FourOsc/LevelMeter chain starves wave-clip audio when no MIDI clip
  // exists — the headless WTEST experiment; the exit demo masked this by
  // loading its melody onto track 0) --
  state.tracks = [{ id: 0, name: '(seeded — unused)', kind: 'unused' }];
  setStatus('building', 'tracks…');
  const fi = await ask('insert-folder', { name: 'SYNTHS', parentFolderId: 0 }, 'folder-inserted');
  if (!fi || typeof fi.folderId !== 'number') throw new Error('insert-folder failed');
  state.folder.folderId = fi.folderId;
  state.tracks.push({ id: -1, name: 'SYNTHS', kind: 'folder' });
  for (const nm of ['Keys', 'Bass']) {
    const r = await ask('add-track-in-folder', { name: nm, folderId: state.folder.folderId }, 'track-added-in-folder');
    if (!r || typeof r.trackId !== 'number' || r.trackId < 0) throw new Error(`add-track-in-folder ${nm} failed`);
    state.tracks.push({ id: r.trackId, name: nm, kind: 'audio' });
  }
  const ab = await ask('add-aux-bus', { busNum: 0, busName: 'Reverb' }, 'aux-bus-added');
  if (!ab || ab.rc !== 0) throw new Error('add-aux-bus failed');
  state.bus.trackId = ab.trackId;
  state.tracks.push({ id: ab.trackId, name: 'Reverb', kind: 'bus' });
  const dr = await ask('add-track', { name: 'Drums' }, 'track-added', 5000);
  if (!dr || typeof dr.trackId !== 'number' || dr.trackId < 0) throw new Error('Drums add-track failed');
  state.tracks.push({ id: dr.trackId, name: 'Drums', kind: 'audio' });
  state.tracks.push({ id: -2, name: 'Master', kind: 'master' });
  const TID = { Drums: dr.trackId, Keys: state.tracks.find(t => t.name === 'Keys').id, Bass: state.tracks.find(t => t.name === 'Bass').id, Bus: ab.trackId };
  state.trackIds = TID;

  // -- plugins --
  setStatus('building', 'plugins…');
  let r = await ask('add-plugin', { trackId: TID.Keys, pluginType: '4bandEq' }, 'plugin-added');
  if (!r || r.rc !== 0) throw new Error('Keys 4bandEq failed');
  r = await ask('add-master-plugin', { pluginType: '4bandEq' }, 'master-plugin-added');
  if (!r || r.rc !== 0) throw new Error('master 4bandEq failed');
  r = await ask('add-plugin', { trackId: TID.Bus, pluginType: 'impulseResponse' }, 'plugin-added', 8000, (m) => m.trackId === TID.Bus);
  if (!r || r.rc !== 0) throw new Error('bus impulseResponse failed');

  // -- the instruments (E1): samples FIRST, then the SFZ text --
  setStatus('building', 'sfizz: the EP + the bass…');
  r = await ask('add-sfizz', { trackId: TID.Keys }, 'sfizz-added', 8000, (m) => m.trackId === TID.Keys);
  if (!r || r.rc !== 0) throw new Error('Keys sfizz failed');
  for (const s of ep) {
    post({ type: 'sfizz-register-sample', trackId: TID.Keys, name: s.name, data: s.pcm,
      numFrames: s.pcm.length, numChannels: 1, sampleRate: SAMPLE_RATE });
  }
  await waitFor('sfizz-sample-count', 8000, (m) => m.trackId === TID.Keys && m.numSamples >= ep.length);
  r = await ask('sfizz-load-string', { trackId: TID.Keys, text: buildSfzText(ep, 85), wait: true }, 'sfizz-loaded', 10000, (m) => m.trackId === TID.Keys);
  if (!r || r.rc !== 0 || r.numRegions !== EXPECT.epRegions) throw new Error(`EP SFZ load failed (regions=${r && r.numRegions})`);

  r = await ask('add-sfizz', { trackId: TID.Bass }, 'sfizz-added', 8000, (m) => m.trackId === TID.Bass);
  if (!r || r.rc !== 0) throw new Error('Bass sfizz failed');
  for (const s of bass) {
    post({ type: 'sfizz-register-sample', trackId: TID.Bass, name: s.name, data: s.pcm,
      numFrames: s.pcm.length, numChannels: 1, sampleRate: SAMPLE_RATE });
  }
  await waitFor('sfizz-sample-count', 4000, (m) => m.trackId === TID.Bass && m.numSamples >= bass.length);
  r = await ask('sfizz-load-string', { trackId: TID.Bass, text: buildSfzText(bass, 80), wait: true }, 'sfizz-loaded', 10000, (m) => m.trackId === TID.Bass);
  if (!r || r.rc !== 0 || r.numRegions !== EXPECT.bassRegions) throw new Error(`Bass SFZ load failed (regions=${r && r.numRegions})`);

  // -- the drum wave clips (E2c): register, insert, introspect --
  setStatus('building', 'drum clips…');
  for (const nm of drumSections) {
    const a = state.assets[nm];
    post({ type: 'register-audio-buffer', name: nm, pcm: a.pcm, numFrames: a.frames, numChannels: a.chans, sampleRate: SAMPLE_RATE });
    const rr = await waitFor('audio-buffer-registered', 12000, (m) => m.name === nm);
    if (!rr || rr.rc !== 0) throw new Error(`register ${nm} failed rc=${rr && rr.rc}`);
  }
  for (let i = 0; i < 4; i++) {
    const nm = drumSections[i];
    post({ type: 'insert-wave-clip', trackId: TID.Drums, name: nm, startSec: i * 4.8, lengthSec: 4.8 });
    const rr = await waitFor('wave-clip-inserted', 8000, (m) => m.trackId === TID.Drums && m.name === nm);
    if (!rr || rr.clipIdx < 0) throw new Error(`insert ${nm} failed rc=${rr && rr.rc}`);
    const info = await ask('get-wave-clip-info', { trackId: TID.Drums, clipIdx: rr.clipIdx }, 'wave-clip-info', 8000, (m) => m.clipIdx === rr.clipIdx);
    if (!info || !info.info) throw new Error(`clip info ${nm} failed`);
    state.waveClips.push({
      trackId: TID.Drums, clipIdx: rr.clipIdx, itemId: Number(info.info.itemId),
      name: nm, start: info.info.start, length: info.info.length,
      srcLengthSec: info.info.srcLengthSec, gainDb: info.info.gainDb, pan: info.info.pan,
      pitch: 0, speed: 1, fades: [info.info.fadeIn, info.info.fadeOut],
    });
  }

  // -- the MIDI (paced, no replies) --
  setStatus('building', 'MIDI…');
  post({ type: 'add-midi-clip', trackId: TID.Keys, startBeat: 0, lengthBeats: TOTAL_BEATS });
  await sleep(60);
  const keysNotes = [];
  CHORDS.forEach((ch, bar) => ch.forEach((p, ci) => keysNotes.push({ pitch: p, velocity: 78 + ((ci * 5 + bar * 3) % 14), startBeat: bar * 4, lengthBeats: 3.75 })));
  for (const m of MELODY) keysNotes.push({ pitch: m[1], velocity: 96, startBeat: m[0], lengthBeats: m[2] });
  { let i = 0; for (const n of keysNotes) { post({ type: 'add-midi-note', trackId: TID.Keys, pitch: n.pitch, velocity: n.velocity, startBeat: n.startBeat, lengthBeats: n.lengthBeats }); if (++i % 24 === 0) await sleep(25); } }
  await sleep(120);
  post({ type: 'add-midi-clip', trackId: TID.Bass, startBeat: 0, lengthBeats: TOTAL_BEATS });
  await sleep(60);
  { let i = 0; for (const n of BASSLINE) { post({ type: 'add-midi-note', trackId: TID.Bass, pitch: n[1], velocity: 90, startBeat: n[0], lengthBeats: n[2] }); if (++i % 24 === 0) await sleep(25); } }
  await sleep(120);
  state.midi[TID.Keys] = [{ startBeat: 0, lengthBeats: TOTAL_BEATS, notes: keysNotes }];
  state.midi[TID.Bass] = [{ startBeat: 0, lengthBeats: TOTAL_BEATS, notes: BASSLINE.map((b) => ({ pitch: b[1], velocity: 90, startBeat: b[0], lengthBeats: b[2] })) }];

  // -- the send + the IR (E2b + E4a/b/c) --
  setStatus('building', 'the reverb bus…');
  r = await ask('add-aux-send', { trackId: TID.Keys, busNum: 0, gainDb: -10 }, 'aux-send-added', 8000, (m) => m.trackId === TID.Keys);
  if (!r || r.rc !== 0) throw new Error('Keys aux send failed');
  state.bus.sendIdx[TID.Keys] = 0;
  const irCopy = irWav.slice(0);                       // transferred — keep the original for V13 re-loads
  post({ type: 'ir-load-data', trackId: TID.Bus, pluginIdx: 0, bytes: irCopy }, [irCopy]);
  r = await waitFor('ir-loaded', 15000, (m) => m.trackId === TID.Bus);
  if (!r || r.rc !== 0) throw new Error(`IR load failed rc=${r && r.rc}`);
  state.irWav = irWav;

  // -- the automation curve (E2e) + the folder submix --
  setStatus('building', 'automation + mix…');
  for (const pt of [{ t: 0, v: -12, c: 0 }, { t: 9.6, v: 0, c: 0 }]) {
    r = await ask('automation-add-point', { trackId: TID.Keys, pluginIdx: 0, paramId: AU.paramId, t: pt.t, v: pt.v, c: pt.c }, 'automation-point-added', 8000,
      (m) => m.trackId === TID.Keys && m.paramId === AU.paramId);
    if (!r || typeof r.index !== 'number') throw new Error('automation point failed');
    state.curve.points.push({ t: pt.t, v: pt.v, c: pt.c });
  }
  r = await ask('set-folder-volume-db', { folderId: state.folder.folderId, db: -10 }, 'folder-volume-set');
  if (!r || r.rc !== 0) recordWarn('folder volume rc=' + (r && r.rc));
  // LEVELS: the bounced mix must peak ≤ ~−1 dBFS (the E4d analysis is the
  // demo's honesty artifact). Drums −8 dB + folder −10 dB + send −10 dB +
  // master 0.35 linear (−9 dB) lands the bounce near −1 dB peak / ~−15 LUFS.
  post({ type: 'set-track-volume', trackId: TID.Drums, gain: dbToLin(-8) });
  // NOTE: set-master-volume + set-track-volume take LINEAR gain (the wrapper
  // does setVolumeDb(linearGainToDb(g))) — dB sliders must convert.
  post({ type: 'set-master-volume', gain: 0.35 });
  post({ type: 'set-plugin-param', trackId: TID.Keys, pluginIdx: 0, paramId: 'Low-pass gain', value: 0 });
  // master EQ starts flat; the Mixer's toggle cuts 'Mid gain 1' at 392 Hz (G4 — present in the pads)
  r = await ask('set-master-param', { pluginIdx: 0, paramId: 'Mid freq 1', value: 392 }, 'master-param-set');
  post({ type: 'set-master-param', pluginIdx: 0, paramId: 'Mid gain 1', value: 0 });
  await sleep(120);

  // -- live input LAST (the §6.7 ordering) --
  post({ type: 'select-input-track', trackId: TID.Keys });
  await sleep(60);
  post({ type: 'enable-live-input' });
  await waitFor('live-input-enabled', 6000);

  built = true;
  setStatus('ready', 'arrangement built — press PLAY');
  renderAll();
  return { ok: true };
}

/* ═════════════════════ SECTION 4 · the UI ════════════════════════════════ */

const LANE_W = 1120;
let laneCanvases = {};

function renderAll() { renderLanes(); renderMixer(); renderInspector(); renderAuCanvas(); }

// ---- 4.1 timeline ----
function laneT(name) { return state.trackIds ? state.trackIds[name] : ({ Drums: 0, Keys: 1, Bass: 2, Bus: 3 })[name]; }

function renderLanes() {
  const gutter = $('gutter'), lanes = $('lanes');
  if (!gutter || !lanes) return;
  gutter.innerHTML = ''; lanes.innerHTML = ''; laneCanvases = {};
  const rows = [
    { name: 'Keys', kind: 'midi', pitchLo: 48, pitchHi: 79, h: 76 },
    { name: 'Bass', kind: 'midi', pitchLo: 26, pitchHi: 52, h: 60 },
    { name: 'Drums', kind: 'wave', h: 76 },
    { name: 'SYNTHS', kind: 'thin' }, { name: 'Reverb', kind: 'thin' }, { name: 'Master', kind: 'thin' },
  ];
  for (const row of rows) {
    const lab = document.createElement('div');
    lab.className = 'lane-label' + (row.kind === 'thin' ? ' lane-thin' : '');
    lab.innerHTML = `<b>${row.name}</b>` + (row.kind === 'thin' ? '' :
      (row.kind === 'midi' ? `<span>${state.midi[laneT(row.name)] ? state.midi[laneT(row.name)][0].notes.length + ' notes' : ''}</span>` : `<span>${state.waveClips.filter(c => c.trackId === DRUMS()).length} clips</span>`));
    gutter.appendChild(lab);
    const lane = document.createElement('div');
    lane.className = 'lane' + (row.kind === 'thin' ? ' lane-thin' : '');
    if (row.kind === 'thin') {
      lane.textContent = row.name === 'SYNTHS' ? 'folder submix · −6 dB' : (row.name === 'Reverb' ? 'aux bus · IR convolution' : '4bandEq (mid-cut toggle in Mixer)');
      lanes.appendChild(lane); continue;
    }
    const cv = document.createElement('canvas');
    cv.width = LANE_W; cv.height = row.h;
    cv.dataset.lane = row.name; cv.dataset.kind = row.kind;
    lane.appendChild(cv); lanes.appendChild(lane);
    laneCanvases[row.name] = { cv, row };
    drawLane(row.name);
    wireLaneDrag(cv);
    cv.addEventListener('pointerdown', (e) => lanePointerDown(e, row.name, cv));
  }
  const ph = document.createElement('div'); ph.id = 'playhead'; lanes.appendChild(ph);
  drawRuler();
}

function drawRuler() {
  const cv = $('ruler-canvas'); if (!cv) return;
  cv.width = LANE_W; cv.height = 22;
  const g = cv.getContext('2d');
  g.fillStyle = '#14161a'; g.fillRect(0, 0, cv.width, cv.height);
  g.font = '10px ui-monospace,monospace'; g.textBaseline = 'middle';
  for (let b = 0; b <= TOTAL_BEATS; b++) {
    const x = b / TOTAL_BEATS * LANE_W;
    g.fillStyle = b % 4 === 0 ? '#4a5060' : '#2a2e38';
    g.fillRect(x, b % 4 === 0 ? 4 : 12, 1, b % 4 === 0 ? 18 : 10);
    if (b % 4 === 0) { g.fillStyle = '#8a93a6'; g.fillText(String(b / 4 + 1), x + 3, 12); }
  }
}

function secToX(s) { return s / TOTAL_SEC * LANE_W; }
function beatToX(b) { return b / TOTAL_BEATS * LANE_W; }

function drawLane(name) {
  const ent = laneCanvases[name]; if (!ent) return;
  const { cv, row } = ent; const g = cv.getContext('2d');
  g.fillStyle = '#101216'; g.fillRect(0, 0, cv.width, cv.height);
  // bar grid
  for (let b = 0; b <= TOTAL_BEATS; b += 1) {
    const x = beatToX(b);
    g.fillStyle = b % 4 === 0 ? '#262b34' : '#191d24';
    g.fillRect(x, 0, 1, cv.height);
  }
  if (row.kind === 'midi') {
    const tid = laneT(name);
    const clip = state.midi[tid] && state.midi[tid][0];
    const yOf = (p) => cv.height - 4 - (p - row.pitchLo) / (row.pitchHi - row.pitchLo) * (cv.height - 8);
    if (clip) for (const n of clip.notes) {
      const x0 = beatToX(n.startBeat), x1 = beatToX(n.startBeat + n.lengthBeats);
      const y = yOf(n.pitch);
      g.fillStyle = name === 'Keys' ? '#d8a54a' : '#7ab8a8';
      const h = Math.max(2.5, cv.height / (row.pitchHi - row.pitchLo) - 0.5);
      g.globalAlpha = 0.55 + 0.45 * (n.velocity / 127);
      g.fillRect(x0 + 0.5, y - h / 2, Math.max(2, x1 - x0 - 1), h);
      g.globalAlpha = 1;
    }
  } else { // wave
    for (const c of state.waveClips.filter((k) => k.trackId === DRUMS())) {
      const x0 = secToX(c.start), w = secToX(c.start + c.length) - x0;
      const a = state.assets[c.name];
      const sel = state.selected && state.selected.kind === 'wave' && state.selected.clipIdx === c.clipIdx;
      g.fillStyle = sel ? '#1d2f45' : '#17202b';
      g.fillRect(x0, 2, w, cv.height - 4);
      g.strokeStyle = sel ? '#5aa2e8' : '#2c3a4a'; g.strokeRect(x0 + 0.5, 2.5, w - 1, cv.height - 5);
      if (a) { // min/max columns from the planar stereo asset
        const n = a.frames, L = a.pcm, R = a.pcm.subarray(n);
        const cols = Math.max(8, Math.floor(w));
        const mid = cv.height / 2;
        g.strokeStyle = sel ? '#79b8ef' : '#3f5871';
        g.beginPath();
        for (let cx = 0; cx < cols; cx++) {
          const i0 = Math.floor(cx / cols * n), i1 = Math.floor((cx + 1) / cols * n);
          if (i1 <= i0) continue;
          let mn = 0, mx = 0;
          for (let i = i0; i < i1; i += 4) { const v = (L[i] + R[i]) * 0.5; if (v < mn) mn = v; if (v > mx) mx = v; }
          const X = x0 + cx;
          g.moveTo(X + 0.5, mid + mn * (cv.height / 2 - 4));
          g.lineTo(X + 0.5, mid + mx * (cv.height / 2 - 4));
        }
        g.stroke();
      }
      g.fillStyle = '#77808f'; g.font = '9px ui-monospace,monospace';
      g.fillText(c.name + (c.pitch ? ` ${c.pitch > 0 ? '+' : ''}${c.pitch}st` : '') + (c.speed !== 1 ? ` ×${c.speed.toFixed(2)}` : ''), x0 + 4, 11);
    }
  }
}

function lanePointerDown(e, name, cv) {
  const rect = cv.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (cv.width / rect.width);
  const sec = x / LANE_W * TOTAL_SEC;
  if (name === 'Drums') {
    const hit = state.waveClips.filter((c) => c.trackId === DRUMS())
      .find((c) => sec >= c.start && sec <= c.start + c.length);
    if (hit) selectClip(0, hit.clipIdx);
    else { // click on empty lane = seek
      post({ type: 'seek', seconds: clamp(sec, 0, TOTAL_SEC - 0.01) });
    }
  } else {
    selectClip(laneT(name), 0, 'midi');
  }
}

function selectClip(trackId, clipIdx, kind = 'wave') {
  state.selected = { trackId, clipIdx, kind };
  drawLane('Drums');
  renderInspector();
}

// drag-move is wired per-lane in renderLanes (wireLaneDrag)

// ---- 4.2 the playhead + position stream ----
onStream('position', (r) => {
  state.position = r.position;
  state.playing = !!r.isPlaying;
  state.lastPosition = r;                    // the raw stream message (diagnostics + tests)
  const ph = $('playhead');
  if (ph) ph.style.left = (r.position / TOTAL_SEC * 100) + '%';
  const bar = Math.floor(r.position / (4 * SEC_PER_BEAT)) + 1;
  const beat = Math.floor((r.position / SEC_PER_BEAT) % 4) + 1;
  const pd = $('pos-display'), ps = $('pos-sec');
  if (pd) pd.textContent = `bar ${bar}.${beat}`;
  if (ps) ps.textContent = r.position.toFixed(2) + ' s';
  updatePlayState(r.isPlaying ? 1 : 0);
});

let lastPlayState = -1;
function updatePlayState(playing) {
  const p = playing ? 1 : 0;
  if (p === lastPlayState) return;
  lastPlayState = p;
  $('btn-play').disabled = p === 1 || !engineReady;
  $('btn-stop').disabled = p !== 1;
  document.querySelectorAll('[data-stop-only]').forEach((el) => { el.disabled = p === 1; });
  $('bpm-input').disabled = p === 1 || !built;
}

// ---- 4.3 the meters (read-and-clear, ~12.5 Hz, discard-after-gap) ----
let meterTimer = null, lastMeterWall = 0;
const meterDb = { master: -100 };
function meterKeyFor(tid) { return String(tid); }
function drawMeters() {
  for (const tidStr in meterCanvasMap) {
    const tid = tidStr === 'master' ? 'master' : Number(tidStr);
    drawMeterBar(meterCanvasMap[tidStr], tid === 'master' ? meterDb.master : (meterDb[meterKeyFor(tid)] ?? -100));
  }
}
const meterCanvasMap = {};
function startMeters() {
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = setInterval(() => {
    if (!engineReady || !built) return;
    const now = performance.now();
    const gapped = now - lastMeterWall > 200;
    lastMeterWall = now;
    if (gapped) { for (const k in meterDb) meterDb[k] = -100; }   // discard the stale accumulation
    for (const tid of [DRUMS(), laneT('Keys'), laneT('Bass'), state.bus.trackId]) {
      if (typeof tid !== 'number' || tid < 0) continue;
      post({ type: 'get-track-level', trackId: tid });
    }
    post({ type: 'get-master-level' });
  }, 80);
}
onStream('trackLevel', (r) => {
  meterDb[meterKeyFor(r.trackId)] = r.levelDb;
  state.meters = state.meters || {};
  state.meters[r.trackId] = r.levelDb;
  drawMeters();
});
onStream('masterLevel', (r) => { meterDb.master = r.levelDb; state.meters = state.meters || {}; state.meters.master = r.levelDb; drawMeters(); });
function drawMeterBar(cv, db) {
  if (!cv) return;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const floor = -60, ceil = 0;
  const frac = db <= -999 ? 0 : clamp((db - floor) / (ceil - floor), 0, 1);
  g.fillStyle = '#151920'; g.fillRect(0, 0, cv.width, cv.height);
  const w = frac * (cv.width - 2);
  g.fillStyle = frac > 0.92 ? '#e06c5a' : frac > 0.75 ? '#d8a54a' : '#5fae7c';
  g.fillRect(1, 1, w, cv.height - 2);
}

// ---- 4.4 the live keyboard ----
const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12 };
let kbOctave = 60;   // C4
const heldNotes = new Set();
function pianoNoteOn(note, vel = 100) {
  if (!built) return;
  if (heldNotes.has(note)) return;
  heldNotes.add(note);
  post({ type: 'note-on', note, velocity: vel });
  paintKeys();
}
function pianoNoteOff(note) {
  if (!heldNotes.has(note)) return;
  heldNotes.delete(note);
  post({ type: 'note-off', note });
  paintKeys();
}
function paintKeys() {
  document.querySelectorAll('#keys .pkey').forEach((el) => {
    const n = Number(el.dataset.note);
    el.classList.toggle('pkey-held', heldNotes.has(n));
  });
}
function buildKeyboard() {
  const box = $('keys'); if (!box) return;
  box.innerHTML = '';
  const base = kbOctave;
  for (let i = 0; i < 25; i++) {                    // 2 octaves
    const n = base + i;
    const sharp = [1, 3, 6, 8, 10].includes(n % 12);
    const el = document.createElement('div');
    el.className = 'pkey' + (sharp ? ' pkey-black' : '');
    el.dataset.note = String(n);
    el.title = noteName(n);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); pianoNoteOn(n, 96); el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', () => pianoNoteOff(n));
    el.addEventListener('pointercancel', () => pianoNoteOff(n));
    box.appendChild(el);
  }
  $('kb-oct').textContent = noteName(kbOctave);
}
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.repeat) return;
  if (e.key === ' ') { e.preventDefault(); toggleTransport(); return; }
  if (e.key === 'z') { kbOctave = Math.max(24, kbOctave - 12); buildKeyboard(); return; }
  if (e.key === 'x') { kbOctave = Math.min(84, kbOctave + 12); buildKeyboard(); return; }
  if (e.key in KEYMAP) pianoNoteOn(kbOctave + KEYMAP[e.key], 96);
});
document.addEventListener('keyup', (e) => { if (e.key in KEYMAP) pianoNoteOff(kbOctave + KEYMAP[e.key]); });

// ---- 4.5 tabs ----
document.querySelectorAll('#tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.remove('tab-active'));
    document.querySelectorAll('#tab-panels .panel').forEach((p) => p.classList.remove('panel-active'));
    btn.classList.add('tab-active');
    $('tab-' + btn.dataset.tab).classList.add('panel-active');
  });
});

// ---- 4.6 the Inspector ----
function renderInspector() {
  const sel = state.selected;
  $('insp-empty').hidden = !!sel;
  $('insp-clip').hidden = !sel;
  if (!sel) return;
  const tid = sel.trackId;
  const tname = (state.tracks.find((t) => t.id === tid) || {}).name || `track ${tid}`;
  if (sel.kind === 'wave') {
    const c = state.waveClips.find((k) => k.trackId === tid && k.clipIdx === sel.clipIdx);
    if (!c) { $('insp-empty').hidden = false; $('insp-clip').hidden = true; return; }
    $('insp-title').textContent = `${tname} · ${c.name}`;
    $('insp-kind').textContent = `wave clip · itemId ${c.itemId}`;
    $('insp-wave').hidden = false; $('insp-midi').hidden = true;
    $('insp-gain').value = c.gainDb; $('insp-gain-v').textContent = c.gainDb.toFixed(1);
    $('insp-pan').value = c.pan; $('insp-pan-v').textContent = Number(c.pan).toFixed(2);
    $('insp-fadein').value = c.fades ? c.fades[0] : 0;
    $('insp-fadeout').value = c.fades ? c.fades[1] : 0;
    $('insp-fades-v').textContent = `${(c.fades ? c.fades[0] : 0).toFixed(2)} / ${(c.fades ? c.fades[1] : 0).toFixed(2)}`;
    $('insp-pitch').value = c.pitch; $('insp-pitch-v').textContent = String(c.pitch);
    $('insp-speed').value = c.speed; $('insp-speed-v').textContent = c.speed.toFixed(2);
  } else {
    const clip = state.midi[tid] && state.midi[tid][0];
    $('insp-title').textContent = `${tname} · MIDI clip`;
    $('insp-kind').textContent = 'MIDI clip (read-only note list)';
    $('insp-wave').hidden = true; $('insp-midi').hidden = false;
    const box = $('insp-midi');
    if (clip) {
      const rows = clip.notes.slice(0, 200).map((n) =>
        `<tr><td>${noteName(n.pitch)}</td><td>${n.startBeat.toFixed(2)}</td><td>${n.lengthBeats.toFixed(2)}</td><td>${n.velocity}</td></tr>`).join('');
      box.innerHTML = `<table class="midi-table"><thead><tr><th>note</th><th>beat</th><th>len</th><th>vel</th></tr></thead><tbody>${rows}</tbody></table>` +
        (clip.notes.length > 200 ? `<div class="insp-empty">… ${clip.notes.length - 200} more</div>` : '');
    } else box.innerHTML = '<div class="insp-empty">no clip</div>';
  }
}

function selWave() {
  const s = state.selected;
  if (!s || s.kind !== 'wave') return null;
  return state.waveClips.find((k) => k.trackId === s.trackId && k.clipIdx === s.clipIdx) || null;
}
async function withUndo(name, fn) {
  post({ type: 'undo-begin', name });
  await waitFor('undo-begun', 3000);
  const out = await fn();
  post({ type: 'pump' });
  return out;
}

// clip gain/pan/fades (stopped-only per the HTML flags)
$('insp-gain').addEventListener('input', async (e) => {
  const c = selWave(); if (!c) return;
  const v = Number(e.target.value);
  post({ type: 'set-clip-gain', trackId: c.trackId, clipIdx: c.clipIdx, gainDb: v });
  const r = await waitFor('clip-gain-set', 3000, (m) => m.clipIdx === c.clipIdx);
  if (r && r.rc === 0) { c.gainDb = v; $('insp-gain-v').textContent = v.toFixed(1); }
});
$('insp-pan').addEventListener('input', async (e) => {
  const c = selWave(); if (!c) return;
  const v = Number(e.target.value);
  post({ type: 'set-clip-pan', trackId: c.trackId, clipIdx: c.clipIdx, pan: v });
  const r = await waitFor('clip-pan-set', 3000, (m) => m.clipIdx === c.clipIdx);
  if (r && r.rc === 0) { c.pan = v; $('insp-pan-v').textContent = v.toFixed(2); }
});
let fadeTimer = null;
function fadesChanged() {
  const c = selWave(); if (!c) return;
  const fi = Number($('insp-fadein').value), fo = Number($('insp-fadeout').value);
  post({ type: 'set-clip-fades', trackId: c.trackId, clipIdx: c.clipIdx, fadeInSec: fi, fadeOutSec: fo });
  waitFor('clip-fades-set', 4000, (m) => m.clipIdx === c.clipIdx).then((r) => {
    if (r && r.rc === 0) {
      c.fades = [fi, fo];
      $('insp-fades-v').textContent = `${fi.toFixed(2)} / ${fo.toFixed(2)}`;
    } else if (r) toast(`fades rejected (rc=${r.rc}) — fadeIn+fadeOut must stay ≤ clip length`);
  });
}
$('insp-fadein').addEventListener('input', () => { clearTimeout(fadeTimer); fadeTimer = setTimeout(fadesChanged, 250); });
$('insp-fadeout').addEventListener('input', () => { clearTimeout(fadeTimer); fadeTimer = setTimeout(fadesChanged, 250); });

// PITCH (the Signalsmith STFT — duration preserved)
$('insp-pitch').addEventListener('input', async (e) => {
  const c = selWave(); if (!c) return;
  const v = Number(e.target.value);
  post({ type: 'set-wave-clip-pitch', trackId: c.trackId, clipIdx: c.clipIdx, semitones: v });
  const r = await waitFor('wave-clip-pitch-set', 4000, (m) => m.clipIdx === c.clipIdx);
  if (r && r.rc === 0) { c.pitch = v; $('insp-pitch-v').textContent = String(v); drawLane('Drums'); }
  else if (r) toast(`pitch rc=${r.rc}`);
});

// SPEED (true varispeed + the §6p.3 window fix for r<1)
$('insp-speed').addEventListener('input', async (e) => {
  const c = selWave(); if (!c) return;
  const v = Number(e.target.value);
  post({ type: 'set-wave-clip-speed', trackId: c.trackId, clipIdx: c.clipIdx, ratio: v });
  const r = await waitFor('wave-clip-speed-set', 4000, (m) => m.clipIdx === c.clipIdx);
  if (!r || r.rc !== 0) { toast(`speed rc=${r && r.rc}`); return; }
  c.speed = v; $('insp-speed-v').textContent = v.toFixed(2);
  // the window fix: the edit length is a pure CachedValue — for r<1 the
  // slowed content needs length = srcLengthSec / r; for r≥1 restore the
  // section length (4.8 s).
  const want = v < 1 ? c.srcLengthSec / v : c.srcLengthSec;
  if (Math.abs(c.length - want) > 0.01) {
    post({ type: 'set-clip-length', itemId: c.itemId, newLengthSec: want });
    const r2 = await waitFor('clip-length-set', 4000, (m) => Number(m.itemId) === c.itemId);
    if (r2 && Number(r2.result) > 0) { c.length = want; drawLane('Drums'); }
  }
  drawLane('Drums');
});

$('insp-split').addEventListener('click', async () => {
  const c = selWave(); if (!c) return;
  const at = clamp(state.position, c.start + 0.05, c.start + c.length - 0.05);
  if (state.position < c.start || state.position > c.start + c.length) { toast('playhead is outside the clip — seek into it first (click the lane)'); return; }
  await withUndo('split clip', async () => {
    post({ type: 'split-clip', itemId: c.itemId, splitSec: at });
    const r = await waitFor('clip-split', 5000, (m) => Number(m.itemId) === c.itemId);
    if (r && Number(r.newItemId) > 0) { await refreshWaveClips(); toast('split — new clip created (Ctrl+Z-class undo via the ↶ button)'); }
    else toast('split failed');
  });
});
$('insp-delete').addEventListener('click', async () => {
  const c = selWave(); if (!c) return;
  await withUndo('delete clip', async () => {
    post({ type: 'delete-clip', itemId: c.itemId });
    const r = await waitFor('clip-deleted', 5000, (m) => Number(m.itemId) === c.itemId);
    if (r && Number(r.result) === 0) { state.selected = null; await refreshWaveClips(); renderInspector(); }
    else toast('delete failed');
  });
});

// re-sync the wave-clip mirror from the engine (observed state)
async function refreshWaveClips() {
  const r = await ask('num-wave-clips', { trackId: DRUMS() }, 'num-wave-clips', 4000, (m) => m.trackId === DRUMS());
  if (!r) return;
  const next = [];
  for (let i = 0; i < r.num; i++) {
    const info = await ask('get-wave-clip-info', { trackId: DRUMS(), clipIdx: i }, 'wave-clip-info', 5000, (m) => m.clipIdx === i);
    if (info && info.info) {
      const old = state.waveClips.find((k) => k.trackId === DRUMS() && k.clipIdx === i);
      next.push({
        trackId: DRUMS(), clipIdx: i, itemId: Number(info.info.itemId), name: info.info.name,
        start: info.info.start, length: info.info.length, srcLengthSec: info.info.srcLengthSec,
        gainDb: info.info.gainDb, pan: info.info.pan,
        pitch: old ? old.pitch : 0, speed: old ? old.speed : 1, fades: [info.info.fadeIn, info.info.fadeOut],
      });
    }
  }
  state.waveClips = next;
  drawLane('Drums');
}

// ---- 4.7 the automation mini-editor (Keys EQ 'Low-pass gain') ----
const AU_CANVAS_W = 720, AU_CANVAS_H = 150;
function renderAuCanvas() {
  const cv = $('au-canvas'); if (!cv) return;
  const g = cv.getContext('2d');
  g.fillStyle = '#101216'; g.fillRect(0, 0, AU_CANVAS_W, AU_CANVAS_H);
  for (let b = 0; b <= TOTAL_BEATS; b += 4) {
    g.fillStyle = '#22262e'; g.fillRect(b / TOTAL_BEATS * AU_CANVAS_W, 0, 1, AU_CANVAS_H);
  }
  const vMin = -24, vMax = 6;
  const xOf = (t) => t / TOTAL_SEC * (AU_CANVAS_W - 20) + 10;
  const yOf = (v) => AU_CANVAS_H - 14 - (v - vMin) / (vMax - vMin) * (AU_CANVAS_H - 28);
  // the curve (linear interp between points)
  const pts = state.curve.points;
  g.strokeStyle = state.curve.bypassed ? '#5a5f6a' : '#d8a54a';
  g.lineWidth = 2; g.beginPath();
  for (let x = 0; x <= AU_CANVAS_W; x += 4) {
    const t = (x - 10) / (AU_CANVAS_W - 20) * TOTAL_SEC;
    let v = pts.length ? pts[pts.length - 1].v : 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (t >= pts[i].t && t <= pts[i + 1].t) {
        const f = pts[i + 1].t === pts[i].t ? 0 : (t - pts[i].t) / (pts[i + 1].t - pts[i].t);
        v = pts[i].v + (pts[i + 1].v - pts[i].v) * f;
      }
    }
    if (x === 0) g.moveTo(x, yOf(v)); else g.lineTo(x, yOf(v));
  }
  g.stroke(); g.lineWidth = 1;
  pts.forEach((p, i) => {
    g.fillStyle = '#0e0f13'; g.strokeStyle = state.curve.bypassed ? '#5a5f6a' : '#e8c06a';
    g.beginPath(); g.arc(xOf(p.t), yOf(p.v), 6, 0, 7); g.fill(); g.stroke();
    g.fillStyle = '#8a93a6'; g.font = '9px ui-monospace,monospace';
    g.fillText(`${i}: ${p.v.toFixed(1)} dB @ ${p.t.toFixed(1)}s`, xOf(p.t) - 20, yOf(p.v) - 10);
  });
  $('au-bypass').checked = state.curve.bypassed;
}
let auDrag = -1;
function auHit(e) {
  const cv = $('au-canvas'); const rect = cv.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (AU_CANVAS_W / rect.width);
  const y = (e.clientY - rect.top) * (AU_CANVAS_H / rect.height);
  const vMin = -24, vMax = 6;
  const xOf = (t) => t / TOTAL_SEC * (AU_CANVAS_W - 20) + 10;
  const yOf = (v) => AU_CANVAS_H - 14 - (v - vMin) / (vMax - vMin) * (AU_CANVAS_H - 28);
  let best = -1, bd = 18;
  state.curve.points.forEach((p, i) => {
    const d = Math.hypot(x - xOf(p.t), y - yOf(p.v));
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
$('au-canvas').addEventListener('pointerdown', (e) => {
  auDrag = auHit(e);
  if (auDrag >= 0) $('au-canvas').setPointerCapture(e.pointerId);
});
$('au-canvas').addEventListener('pointermove', async (e) => {
  if (auDrag < 0) return;
  const rect = $('au-canvas').getBoundingClientRect();
  const y = (e.clientY - rect.top) * (AU_CANVAS_H / rect.height);
  const vMin = -24, vMax = 6;
  const v = clamp(vMin + (AU_CANVAS_H - 14 - y) / (AU_CANVAS_H - 28) * (vMax - vMin), vMin, vMax);
  const p = state.curve.points[auDrag];
  post({ type: 'automation-set-point-value', trackId: AU.trackId, pluginIdx: AU.pluginIdx, paramId: AU.paramId, pointIdx: auDrag, v });
  const r = await waitFor('automation-point-value-set', 3000, (m) => m.pointIdx === auDrag);
  if (r && r.rc === 0) { p.v = v; renderAuCanvas(); }
});
$('au-canvas').addEventListener('pointerup', () => { auDrag = -1; });
$('au-bypass').addEventListener('change', async (e) => {
  const bypass = e.target.checked;
  post({ type: 'automation-set-bypass', trackId: AU.trackId, pluginIdx: AU.pluginIdx, paramId: AU.paramId, bypass });
  const r = await waitFor('automation-bypass-set', 3000);
  if (r && r.rc === 0) { state.curve.bypassed = bypass; renderAuCanvas(); }
});

// ---- 4.8 the Mixer ----
function renderMixer() {
  const box = $('mixer'); if (!box) return;
  box.innerHTML = '';
  for (const k of Object.keys(meterCanvasMap)) delete meterCanvasMap[k];
  const strips = [
    { tid: DRUMS(), name: 'Drums', send: false },
    { tid: laneT('Keys'), name: 'Keys', send: true },
    { tid: laneT('Bass'), name: 'Bass', send: true },
    { tid: state.bus.trackId, name: 'Reverb', send: false, isBus: true },
  ];
  for (const s of strips) {
    if (typeof s.tid !== 'number' || s.tid < 0) continue;
    box.appendChild(buildStrip(s));
  }
  // folder strip
  const fdiv = document.createElement('div');
  fdiv.className = 'strip strip-folder';
  fdiv.innerHTML = `<div class="strip-name">SYNTHS</div>
    <label class="strip-lab">folder dB</label>
    <input type="range" min="-30" max="6" step="0.5" value="${state.folder.volumeDb}" id="fld-vol">
    <span class="strip-val">${state.folder.volumeDb} dB</span>
    <button class="tb tb-mini" id="fld-mute">M</button>
    <div class="strip-note">E2e submix</div>`;
  box.appendChild(fdiv);
  fdiv.querySelector('#fld-vol').addEventListener('input', async (e) => {
    const v = Number(e.target.value);
    post({ type: 'set-folder-volume-db', folderId: state.folder.folderId, db: v });
    const r = await waitFor('folder-volume-set', 3000);
    if (r && r.rc === 0) { state.folder.volumeDb = v; fdiv.querySelector('.strip-val').textContent = v + ' dB'; }
  });
  fdiv.querySelector('#fld-mute').addEventListener('click', async (e) => {
    const mute = !e.target.classList.contains('on');
    post({ type: 'set-folder-mute', folderId: state.folder.folderId, mute });
    const r = await waitFor('folder-mute-set', 3000);
    if (r && r.rc === 0) e.target.classList.toggle('on', mute);
  });
  // master strip
  const mdiv = document.createElement('div');
  mdiv.className = 'strip strip-master';
  mdiv.innerHTML = `<div class="strip-name">MASTER</div>
    <canvas class="strip-meter" width="14" height="120" data-meter="master"></canvas>
    <label class="strip-lab">dB</label>
    <input type="range" min="-40" max="6" step="0.5" value="0" id="ms-vol">
    <span class="strip-val">0.0 dB</span>
    <button class="tb tb-mini" id="ms-eq" title="LIVE mid-cut on the master 4bandEq ('Mid gain 1' −18 dB @ 392 Hz — G4, in every pad)">EQ cut: OFF</button>
    <div class="strip-note">4bandEq · live toggle</div>`;
  box.appendChild(mdiv);
  meterCanvasMap.master = mdiv.querySelector('[data-meter="master"]');
  mdiv.querySelector('#ms-vol').addEventListener('input', (e) => {
    const db = Number(e.target.value);
    post({ type: 'set-master-volume', gain: dbToLin(db) });  // LINEAR contract
    mdiv.querySelector('.strip-val').textContent = db.toFixed(1) + ' dB';
  });
  mdiv.querySelector('#ms-eq').addEventListener('click', async (e) => {
    const on = !e.target.classList.contains('on');
    post({ type: 'set-master-param', pluginIdx: 0, paramId: 'Mid gain 1', value: on ? -18 : 0 });
    const r = await waitFor('master-param-set', 3000, (m) => m.paramId === 'Mid gain 1');
    if (r && r.rc === 0) {
      e.target.classList.toggle('on', on);
      e.target.textContent = 'EQ cut: ' + (on ? 'ON' : 'OFF');
      toast(on ? 'mid cut ON — listen to the pads thin out' : 'mid cut OFF');
    }
  });
}

function buildStrip(s) {
  const div = document.createElement('div');
  div.className = 'strip' + (s.isBus ? ' strip-bus' : '');
  div.innerHTML = `<div class="strip-name">${s.name}</div>
    <canvas class="strip-meter" width="14" height="120" data-meter="${s.tid}"></canvas>
    <label class="strip-lab">dB</label>
    <input type="range" class="st-vol" min="-60" max="6" step="0.5" value="0">
    <span class="strip-val">0.0 dB</span>
    <label class="strip-lab">pan</label>
    <input type="range" class="st-pan" min="-1" max="1" step="0.05" value="0">
    <span class="strip-val st-panv">0.00</span>
    <div class="strip-btns"><button class="tb tb-mini st-mute">M</button><button class="tb tb-mini st-solo">S</button></div>
    ${s.send ? `<label class="strip-lab">→ Reverb dB</label>
    <input type="range" class="st-send" min="-48" max="6" step="0.5" value="${s.tid === laneT('Keys') ? 0 : -48}">
    <span class="strip-val st-sendv">${s.tid === laneT('Keys') ? '0.0' : '-48.0'}</span>` : ''}
    <div class="strip-note">${s.isBus ? 'IR · bus 0' : 'audio track'}</div>`;
  meterCanvasMap[s.tid] = div.querySelector('[data-meter]');
  div.querySelector('.st-vol').addEventListener('input', (e) => {
    const db = Number(e.target.value);
    post({ type: 'set-track-volume', trackId: s.tid, gain: dbToLin(db) });   // LINEAR contract
    div.querySelector('.strip-val').textContent = db.toFixed(1) + ' dB';
  });
  div.querySelector('.st-pan').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    post({ type: 'set-track-pan', trackId: s.tid, pan: v });
    div.querySelector('.st-panv').textContent = v.toFixed(2);
  });
  div.querySelector('.st-mute').addEventListener('click', (e) => {
    const mute = !e.target.classList.contains('on');
    post({ type: 'set-track-mute', trackId: s.tid, mute });
    e.target.classList.toggle('on', mute);
  });
  div.querySelector('.st-solo').addEventListener('click', (e) => {
    const solo = !e.target.classList.contains('on');
    post({ type: 'set-track-solo', trackId: s.tid, solo });
    e.target.classList.toggle('on', solo);
  });
  const sendEl = div.querySelector('.st-send');
  if (sendEl) sendEl.addEventListener('input', async (e) => {
    const v = Number(e.target.value);
    post({ type: 'set-aux-send-gain', trackId: s.tid, sendIdx: 0, gainDb: v });
    const r = await waitFor('aux-send-gain-set', 3000, (m) => m.trackId === s.tid);
    if (r && r.rc === 0) div.querySelector('.st-sendv').textContent = v.toFixed(1);
  });
  return div;
}

/* ---- 4.9 the Analysis tab (E3 bounce + E4d analysis) ---- */
$('an-bounce').addEventListener('click', async () => {
  if (!built) { toast('build the arrangement first'); return; }
  anBusy('bouncing (offline render — a few seconds)…');
  try {
    post({ type: 'bounce-render', path: state.bounce.path, startSec: 0, endSec: TOTAL_SEC, blockSize: 128, useMasterPlugins: 1, endAllowanceMs: 1500 });
    let r = await waitFor('bounce-rendered', 60000);
    if (!r || r.rc !== 0) { toast('bounce failed rc=' + (r && r.rc)); return; }
    r = await ask('bounce-stats', null, 'bounce-stats', 5000);
    state.bounce.stats = r;
    post({ type: 'bounce-read-file', path: state.bounce.path });
    const br = await waitFor('bounce-read-file', 20000);
    if (br && br.rc === 0 && br.bytes) {
      state.bounce.bytes = br.bytes;
      $('an-download').disabled = false;
    } else recordWarn('bounce-read-file rc=' + (br && br.rc) + ' (download disabled)');
    $('an-analyse').disabled = false;
    const st = $('an-stats');
    st.innerHTML = `<b>bounce OK</b> — ${r ? `${(r.durationSec || 0).toFixed(2)} s · ${(r.frames || 0)} frames · RMS ${(r.rms || 0).toFixed(4)} · peak ${(r.peak || 0).toFixed(4)}` : 'stats n/a'}`;
  } finally { anBusy(''); }
});
$('an-analyse').addEventListener('click', async () => {
  if (!state.bounce.stats) { toast('bounce first'); return; }
  anBusy('analysing (the 65k-frame E4d pass — audio pauses briefly)…');
  try {
    post({ type: 'analyse-audio-file', path: state.bounce.path });
    const r = await waitFor('audio-analysed', 120000);
    if (!r) { toast('analyse timed out'); return; }
    let j = null;
    try { j = JSON.parse(r.json); } catch (e) { toast('analyse JSON parse failed'); return; }
    if (j.error) { toast('analyse error: ' + j.error); return; }
    state.lastAnalysis = j;
    renderAnalysis(j);
  } finally { anBusy(''); }
});
$('an-download').addEventListener('click', () => {
  if (!state.bounce.bytes) return;
  const blob = new Blob([state.bounce.bytes], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'v2-demo-bounce.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('WAV downloading — open it in your player and A/B against the live page');
});
// the automation A/B: two bounces (curve active vs bypassed), band compare
$('an-ab').addEventListener('click', async () => {
  if (!built) { toast('build first'); return; }
  const out = $('an-ab-out');
  out.textContent = 'bouncing pair…';
  const analyzeOne = async (label) => {
    post({ type: 'bounce-render', path: state.bounce.path, startSec: 0, endSec: TOTAL_SEC, blockSize: 128, useMasterPlugins: 1, endAllowanceMs: 1500 });
    const r = await waitFor('bounce-rendered', 60000);
    if (!r || r.rc !== 0) throw new Error('bounce failed (' + label + ')');
    post({ type: 'analyse-audio-file', path: state.bounce.path });
    const a = await waitFor('audio-analysed', 120000);
    if (!a) throw new Error('analyse failed (' + label + ')');
    post({ type: 'bounce-read-file', path: state.bounce.path });
    const br = await waitFor('bounce-read-file', 20000);
    return { json: JSON.parse(a.json), bytes: br && br.rc === 0 ? br.bytes : null, label };
  };
  try {
    // curve ACTIVE first (current state assumed active)
    if (state.curve.bypassed) { post({ type: 'automation-set-bypass', ...AU, bypass: false }); await waitFor('automation-bypass-set', 3000); state.curve.bypassed = false; renderAuCanvas(); }
    const on = await analyzeOne('ON');
    post({ type: 'automation-set-bypass', ...AU, bypass: true });
    await waitFor('automation-bypass-set', 3000);
    state.curve.bypassed = true; renderAuCanvas();
    const off = await analyzeOne('OFF');
    post({ type: 'automation-set-bypass', ...AU, bypass: false });
    await waitFor('automation-bypass-set', 3000);
    state.curve.bypassed = false; renderAuCanvas();
    // compare a mid/high band where the low-pass-gain curve bites
    const pick = (j) => {
      const bands = (j.spectrum && j.spectrum.thirdOctaveDb) || [];
      return bands.length ? bands : null;
    };
    const bon = pick(on.json), boff = pick(off.json);
    let deltaTxt = 'band data unavailable';
    if (bon && boff && bon.length === boff.length) {
      let bestI = -1, bestD = 0;
      for (let i = 0; i < bon.length; i++) { const d = (boff[i] || 0) - (bon[i] || 0); if (Math.abs(d) > Math.abs(bestD)) { bestD = d; bestI = i; } }
      deltaTxt = `max band delta ${bestD >= 0 ? '+' : ''}${bestD.toFixed(1)} dB at band #${bestI}`;
    }
    out.innerHTML = `<b>curve ON vs OFF</b> — ${deltaTxt}.<br>` +
      `ON: peakDb ${fmtDb(on.json.peakDb)} · LUFS ${fmtDb(on.json.integratedLufs)} — OFF: peakDb ${fmtDb(off.json.peakDb)} · LUFS ${fmtDb(off.json.integratedLufs)}.<br>` +
      `Download each from the log below and listen: the ON render carries the −12 dB → 0 dB swell over the first half.`;
    for (const rec of [on, off]) if (rec.bytes) {
      const blob = new Blob([rec.bytes], { type: 'audio/wav' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `v2-demo-curve-${rec.label}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  } catch (e) { out.textContent = 'A/B failed: ' + String(e.message || e); }
});
function fmtDb(v) { return (v === null || v === undefined || Number.isNaN(v)) ? 'n/a' : Number(v).toFixed(1); }
function anBusy(s) { $('an-busy').textContent = s; }
function renderAnalysis(j) {
  const box = $('an-json');
  const rows = [
    ['sample peak', fmtDb(j.peakDb) + ' dB'], ['TRUE PEAK (4× ISP)', fmtDb(j.truePeakDb) + ' dB'],
    ['RMS', fmtDb(j.rmsDb) + ' dB'], ['LUFS integrated', fmtDb(j.integratedLufs)],
    ['LUFS momentary max', fmtDb(j.maxMomentaryLufs)], ['LUFS short-term max', fmtDb(j.maxShortTermLufs)],
    ['loudness range LRA', fmtDb(j.loudnessRange)], ['clipped samples', String(j.clippedSamples ?? 'n/a')],
    ['silence ratio', j.silenceRatio !== undefined ? (100 * j.silenceRatio).toFixed(1) + ' %' : 'n/a'],
    ['spectrum centroid', j.centroidHz !== undefined ? j.centroidHz.toFixed(0) + ' Hz' : 'n/a'],
    ['rolloff', j.rolloffHz !== undefined ? j.rolloffHz.toFixed(0) + ' Hz' : 'n/a'],
    ['duration', j.durationSec !== undefined ? j.durationSec.toFixed(2) + ' s' : 'n/a'],
  ];
  box.innerHTML = rows.map(([k, v]) => `<div class="an-row-kv"><span>${k}</span><b>${v}</b></div>`).join('');
  drawBands(j);
}
function drawBands(j) {
  const cv = $('an-bands'); const g = cv.getContext('2d');
  g.fillStyle = '#101216'; g.fillRect(0, 0, cv.width, cv.height);
  const bands = (j.spectrum && (j.spectrum.thirdOctaveDb || j.spectrum.bandsDb)) || null;
  if (!bands || !bands.length) { g.fillStyle = '#666'; g.fillText('no band data', 8, 14); return; }
  const w = cv.width / bands.length;
  for (let i = 0; i < bands.length; i++) {
    const db = clamp(bands[i] ?? -90, -90, 0);
    const h = (db + 90) / 90 * (cv.height - 16);
    g.fillStyle = '#5fae7c';
    g.fillRect(i * w + 1, cv.height - 12 - h, Math.max(1, w - 2), h);
  }
  g.fillStyle = '#77808f'; g.font = '9px ui-monospace,monospace';
  g.fillText('0 dB', 2, 10); g.fillText('-90', 2, cv.height - 4);
}
// live spectrum strip
function drawLiveSpectrum() {
  const cv = $('an-spectrum'); if (!cv || !analyser) return;
  const g = cv.getContext('2d');
  if (!fftBuf || fftBuf.length !== analyser.frequencyBinCount) fftBuf = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(fftBuf);
  g.fillStyle = '#101216'; g.fillRect(0, 0, cv.width, cv.height);
  const n = Math.floor(fftBuf.length / 4);   // ~0-5.8 kHz
  for (let i = 0; i < n; i++) {
    const db = clamp(fftBuf[i], -90, 0);
    const h = (db + 90) / 90 * cv.height;
    g.fillStyle = i * (SAMPLE_RATE / analyser.fftSize) < 1000 ? '#7ab8a8' : '#5fae7c';
    g.fillRect(i / n * cv.width, cv.height - h, cv.width / n + 0.5, h);
  }
}
setInterval(() => { if (state.playing && document.querySelector('#tab-analysis.panel-active')) drawLiveSpectrum(); }, 120);

/* ---- 4.10 the transport + top bar ---- */
async function toggleTransport() {
  if (!built) { toast('build the arrangement first'); return; }
  if (state.playing) post({ type: 'transport-stop' });
  else { post({ type: 'transport-play' }); state.everPlayed = true; }
}
$('btn-play').addEventListener('click', toggleTransport);
$('btn-stop').addEventListener('click', () => post({ type: 'transport-stop' }));
$('btn-undo').addEventListener('click', async () => {
  post({ type: 'undo' });
  const r = await waitFor('undo-done', 4000);
  if (r && r.rc === 0) { await refreshWaveClips(); renderInspector(); toast('undo OK'); }
  else toast('nothing to undo');
});
$('btn-redo').addEventListener('click', async () => {
  post({ type: 'redo' });
  const r = await waitFor('redo-done', 4000);
  if (r && r.rc === 0) { await refreshWaveClips(); renderInspector(); toast('redo OK'); }
  else toast('nothing to redo');
});
$('bpm-input').addEventListener('change', (e) => {
  const v = clamp(Number(e.target.value) || 100, 40, 240);
  e.target.value = v;
  post({ type: 'set-bpm', bpm: v });
  toast(`BPM ${v} — MIDI is beat-mapped, wave clips stay time-anchored (the remap semantics)`);
});
$('master-vol').addEventListener('input', (e) => {
  const db = Number(e.target.value);
  post({ type: 'set-master-volume', gain: dbToLin(db) });   // LINEAR contract
  $('master-vol-v').textContent = db.toFixed(1) + ' dB';
});
onStream('masterLevel', (r) => { drawMeterBar($('master-meter'), r.levelDb); });
$('warn-toggle').addEventListener('click', () => {
  const list = $('warn-list');
  list.hidden = !list.hidden;
  if (!list.hidden) renderWarnList();
});
$('kb-target').addEventListener('change', async (e) => {
  const tid = Number(e.target.value);
  post({ type: 'select-input-track', trackId: tid });
  await sleep(80);
  post({ type: 'enable-live-input' });
  toast('live input → ' + (tid === laneT('Keys') ? 'Keys' : 'Bass'));
});
$('kb-oct-down').addEventListener('click', () => { kbOctave = Math.max(24, kbOctave - 12); buildKeyboard(); });
$('kb-oct-up').addEventListener('click', () => { kbOctave = Math.min(84, kbOctave + 12); buildKeyboard(); });

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3400);
}

/* ═════════════════════ SECTION 5 · the Verify suite (spec §8) ════════════ */

// parked-seek discipline (§6.13): stop → 300ms → seek → 200ms → play → 600ms
async function parkedPlay(fromSec) {
  post({ type: 'transport-stop' });
  await sleep(300);
  post({ type: 'seek', seconds: fromSec });
  await sleep(200);
  post({ type: 'transport-play' });
  state.everPlayed = true;   // the suite's warmup gate (the E1 first-play lesson)
  await sleep(600);
}
async function stopTransport() { post({ type: 'transport-stop' }); await sleep(350); }

function dominantFreqHz(loHz = 50, hiHz = 8000) {
  analyser.getFloatFrequencyData(fftBuf);
  const binHz = SAMPLE_RATE / analyser.fftSize;
  const b0 = Math.floor(loHz / binHz), b1 = Math.min(fftBuf.length - 1, Math.ceil(hiHz / binHz));
  let best = -Infinity, bi = b0;
  for (let b = b0; b <= b1; b++) if (fftBuf[b] > best) { best = fftBuf[b]; bi = b; }
  return bi * binHz;
}

const VERIFY = {
  async V1() {
    const nt = await ask('num-tracks', null, 'track-count', 4000);
    const wc = await ask('num-wave-clips', { trackId: DRUMS() }, 'num-wave-clips', 4000, (m) => m.trackId === DRUMS());
    const c1 = await ask('get-clip-count', { trackId: laneT('Keys') }, 'clip-count', 4000, (m) => m.trackId === laneT('Keys'));
    const c2 = await ask('get-clip-count', { trackId: laneT('Bass') }, 'clip-count', 4000, (m) => m.trackId === laneT('Bass'));
    const np1 = await ask('num-plugins', { trackId: laneT('Keys') }, 'plugin-count', 4000, (m) => m.trackId === laneT('Keys'));
    const npM = await ask('num-master-plugins', null, 'master-plugin-count', 4000);
    const npB = await ask('num-plugins', { trackId: state.bus.trackId }, 'plugin-count', 4000, (m) => m.trackId === state.bus.trackId);
    const hz1 = await ask('has-sfizz', { trackId: laneT('Keys') }, 'sfizz-status', 4000, (m) => m.trackId === laneT('Keys'));
    const hz2 = await ask('has-sfizz', { trackId: laneT('Bass') }, 'sfizz-status', 4000, (m) => m.trackId === laneT('Bass'));
    const rg1 = await ask('sfizz-num-regions', { trackId: laneT('Keys') }, 'sfizz-region-count', 4000, (m) => m.trackId === laneT('Keys'));
    const rg2 = await ask('sfizz-num-regions', { trackId: laneT('Bass') }, 'sfizz-region-count', 4000, (m) => m.trackId === laneT('Bass'));
    const ntExpect = EXPECT.numTracks + (state.scratch ? 1 : 0);   // the scratch track may pre-exist (a standalone V4/V8/V9 ran first)
    const m = `tracks ${nt && nt.numTracks}/${ntExpect} · waveClips ${wc && wc.num} · midiClips ${c1 && c1.count}/${c2 && c2.count} · plugins(Keys/Master/Bus) ${np1 && np1.numPlugins}/${npM && npM.numPlugins}/${npB && npB.numPlugins} · sfizz ${hz1 && hz1.hasSfizz}/${hz2 && hz2.hasSfizz} · regions ${rg1 && rg1.numRegions}/${rg2 && rg2.numRegions}`;
    const ok = nt && nt.numTracks === ntExpect && wc && wc.num === EXPECT.waveClipsT0
      && c1 && c1.count === 1 && c2 && c2.count === 1
      && np1 && np1.numPlugins === EXPECT.pluginsT1 && npM && npM.numPlugins === EXPECT.pluginsMaster
      && npB && npB.numPlugins === EXPECT.pluginsBus
      && hz1 && hz1.hasSfizz === 1 && hz2 && hz2.hasSfizz === 1
      && rg1 && rg1.numRegions === EXPECT.epRegions && rg2 && rg2.numRegions === EXPECT.bassRegions;
    return { pass: !!ok, measured: m };
  },
  async V2() {
    await parkedPlay(0.1);
    await sleep(900);                       // inside bar 1 (Em: E3+B3+E4+G4)
    // NOTE: a f×1.32 neighbour collides with the NEXT CHORD TONE (B3's
    // neighbour = 326 Hz ≈ E4 329.6). Measure against a FIXED quiet band
    // (550 Hz — no chord/melody content in bar 1) instead.
    const quiet = bandEnergyDb(550).at;
    const e3 = bandEnergyDb(164.81).at, b3 = bandEnergyDb(246.94).at, e4 = bandEnergyDb(329.63).at;
    await stopTransport();
    const m = `E3 ${e3.toFixed(1)} · B3 ${b3.toFixed(1)} · E4 ${e4.toFixed(1)} vs quiet550 ${quiet.toFixed(1)} dB`;
    const ok = (e3 - quiet >= 6) && (b3 - quiet >= 6) && (e4 - quiet >= 6);
    return { pass: ok, measured: m };
  },
  async V3() {
    await stopTransport();
    await sleep(400);
    const pre = bandEnergyDb(329.63);
    pianoNoteOn(64, 100);
    await sleep(1000);
    const dur = bandEnergyDb(329.63);
    pianoNoteOff(64);
    const m = `E4 live: pre ${pre.at.toFixed(1)} · during ${dur.at.toFixed(1)} · Δ ${(dur.at - pre.at).toFixed(1)} dB`;
    return { pass: (dur.at - pre.at >= 6), measured: m };
  },
  async V4() {
    // THE SCRATCH-SINE CARRIER (the 2026-09-21 public-URL saga): the Keys
    // pad proved UNRELIABLE as a live-write carrier — bar 1 has a rising
    // envelope (−49 → −38 across one play), the level varies play-to-play,
    // and drum transients + the bass's 4th harmonic (= E4 EXACTLY,
    // 82.41 × 4 = 329.63) bleed into the band — three separate failure
    // modes observed before this rewrite. The scratch 440 Hz sine (the
    // V8/V9 carrier, deterministic every run) with _scratch's full
    // isolation (drums + folder + bus muted) measures the LIVE fader
    // write cleanly. The TEST track also feeds V13's expectTracks (+1).
    const sc = await VERIFY._scratch();
    try {
      await parkedPlay(0.5);               // inside the sine's 0–2 s span, settled
      await sleep(300);
      const before = bandEnergyDb(440, 25).at;
      post({ type: 'set-track-volume', trackId: sc.tid, gain: dbToLin(-20) });  // LINEAR contract
      await sleep(400);
      const after = bandEnergyDb(440, 25).at;
      post({ type: 'set-track-volume', trackId: sc.tid, gain: 1.0 });
      await stopTransport();
      const ratio = Math.pow(10, (after - before) / 20);
      const m = `440 Hz scratch sine −20 dB live write: ${before.toFixed(1)} → ${after.toFixed(1)} dB · ratio ${ratio.toFixed(3)}`;
      return { pass: ratio >= 0.06 && ratio <= 0.16, measured: m };
    } finally { await VERIFY._unscratch(); }
  },
  async V5() {
    // the E2f fix: the Keys band after a mute→unmute cycle must match the clean render.
    // WARMUP FIRST: the first play of a fresh engine absorbs the sfizz
    // freewheeling load in its opening blocks (the E1 lesson) — measure
    // only from the SECOND play on.
    await parkedPlay(0.1);
    await sleep(1300);
    await stopTransport();
    const bandAvg = async (n = 3) => { let s = 0; for (let i = 0; i < n; i++) { s += bandEnergyDb(329.63).at; await sleep(150); } return s / n; };
    await parkedPlay(0.1);
    await sleep(100);
    const r1 = await bandAvg(3);
    await stopTransport();
    post({ type: 'set-track-mute', trackId: laneT('Keys'), mute: true });
    await parkedPlay(0.1); await sleep(400);        // a render happens while muted
    await stopTransport();
    post({ type: 'set-track-mute', trackId: laneT('Keys'), mute: false });
    await sleep(250);
    await parkedPlay(0.1);
    await sleep(100);
    const r2 = await bandAvg(3);
    await stopTransport();
    const ratio = Math.pow(10, (r2 - r1) / 20);
    // window [0.70, 1.45]: the pads' τ=0.45 s decay means ±150 ms of
    // play-settle drift between legs ≈ ±3 dB — the pre-fix signature was
    // 1.71 (+4.6 dB), far outside even this window
    const m = `E4 band clean ${r1.toFixed(1)} dB vs post-unmute ${r2.toFixed(1)} dB · ratio ${ratio.toFixed(3)} (pre-fix: 1.71)`;
    return { pass: ratio >= 0.70 && ratio <= 1.45, measured: m };
  },
  async V6() {
    await parkedPlay(0.1);
    await sleep(600);
    const g4 = 392.0;                               // G4 — present in every pad chord
    const off = bandEnergyDb(g4);
    post({ type: 'set-master-param', pluginIdx: 0, paramId: 'Mid gain 1', value: -18 });
    await sleep(500);
    const on = bandEnergyDb(g4);
    post({ type: 'set-master-param', pluginIdx: 0, paramId: 'Mid gain 1', value: 0 });
    await stopTransport();
    const dip = off.at - on.at;
    const m = `G4 band cut OFF ${off.at.toFixed(1)} vs ON ${on.at.toFixed(1)} · dip ${dip.toFixed(1)} dB`;
    return { pass: dip >= 8, measured: m };
  },
  async V7() {
    await stopTransport();
    // WARMUP: the first sfizz note on a fresh engine is absorbed by the
    // freewheeling load (the E1 lesson — a fresh-build V7 measured floor
    // at -140 dB on all legs before this).
    pianoNoteOn(60, 100);
    await sleep(900);
    pianoNoteOff(60);
    await sleep(500);
    // THE PRE-FADER TRICK (V7 v4, the 2026-09-21 saga's endpoint): the aux
    // sends are PRE-FADER (V4's old masking note) — so DUCK THE TRACK FADER
    // during the test: the dry EP (and its variable-lifetime release, which
    // buried the ring in the two-leg-subtraction design) goes ~30 dB down
    // while the wet send path is UNTOUCHED. Leg A reads the PURE ring; leg
    // B (send killed) reads the pure floor. No release contamination, no
    // offset racing. The ring itself measures ~−105 dB on the browser path
    // (vs −37 predicted by the native τ e-fold — a recorded divergence).
    const f = 329.63;
    const K = laneT('Keys');
    post({ type: 'set-aux-send-gain', trackId: K, sendIdx: 0, gainDb: 0 });
    post({ type: 'set-track-volume', trackId: K, gain: dbToLin(-30) });   // bury the dry + its release
    await sleep(350);
    const preA = bandEnergyDb(f);
    pianoNoteOn(64, 100);
    await sleep(1100);
    const duringA = bandEnergyDb(f);       // the wet path alone (send pre-fader)
    pianoNoteOff(64);
    const tailA = [0, 0, 0];
    for (let i = 0; i < 3; i++) { await sleep(450); tailA[i] = bandEnergyDb(f).at; }   // the pure ring at +450/+900/+1350
    await sleep(600);
    post({ type: 'set-aux-send-gain', trackId: K, sendIdx: 0, gainDb: -90 });
    await sleep(300);
    const preB = bandEnergyDb(f);
    pianoNoteOn(64, 100);
    await sleep(1100);
    const duringB = bandEnergyDb(f);
    pianoNoteOff(64);
    const tailB = [0, 0, 0];
    for (let i = 0; i < 3; i++) { await sleep(450); tailB[i] = bandEnergyDb(f).at; }
    post({ type: 'set-track-volume', trackId: K, gain: 1.0 });            // restore
    post({ type: 'set-aux-send-gain', trackId: K, sendIdx: 0, gainDb: -10 });  // the musical level
    let wet = -Infinity, wetAt = 0;
    for (let i = 0; i < 3; i++) { const d = tailA[i] - tailB[i]; if (d > wet) { wet = d; wetAt = 450 * (i + 1); } }
    const m = `ring Δ ${wet.toFixed(1)} dB @ +${wetAt} ms (A ${tailA.map((v) => v.toFixed(0)).join('/')} vs floor ${tailB.map((v) => v.toFixed(0)).join('/')}) · wet-during ${duringA.at.toFixed(1)} vs dry-ducked ${duringB.at.toFixed(1)} · pre ${preA.at.toFixed(1)}/${preB.at.toFixed(1)} dB`;
    return { pass: (duringA.at - preA.at >= 10) && wet >= 6, measured: m };
  },
  // V8/V9 share ONE scratch track + a timing-fixed leg helper: the
  // (dominant frequency, content end) PAIR is the discriminator — the
  // content-end watch MUST start at the same playback offset in both legs
  // or the windows don't cancel.
  async _scratch() {
    if (state.scratch) {
      const a = state.assets['test_sine'];
      post({ type: 'register-audio-buffer', name: 'test_sine', pcm: a.pcm, numFrames: a.frames, numChannels: a.chans, sampleRate: SAMPLE_RATE });
      const rr0 = await waitFor('audio-buffer-registered', 8000, (m) => m.name === 'test_sine');
      if (!rr0 || rr0.rc !== 0) throw new Error('sine re-register failed');
      post({ type: 'insert-wave-clip', trackId: state.scratch.tid, name: 'test_sine', startSec: 0, lengthSec: 2.0 });
      const ic0 = await waitFor('wave-clip-inserted', 8000, (m) => m.trackId === state.scratch.tid);
      if (!ic0 || ic0.clipIdx < 0) throw new Error('sine re-insert failed');
      const i0 = await ask('get-wave-clip-info', { trackId: state.scratch.tid, clipIdx: ic0.clipIdx }, 'wave-clip-info', 5000, (m) => m.clipIdx === ic0.clipIdx);
      state.scratch.clipIdx = ic0.clipIdx; state.scratch.itemId = Number(i0.info.itemId);
    } else {
      const t = await ask('add-track', { name: 'TEST' }, 'track-added', 5000);
      if (!t || typeof t.trackId !== 'number' || t.trackId < 0) throw new Error('add-track failed');
      const tid = t.trackId;
      const a = state.assets['test_sine'];
      post({ type: 'register-audio-buffer', name: 'test_sine', pcm: a.pcm, numFrames: a.frames, numChannels: a.chans, sampleRate: SAMPLE_RATE });
      const rr = await waitFor('audio-buffer-registered', 8000, (m) => m.name === 'test_sine');
      if (!rr || rr.rc !== 0) throw new Error('sine register failed');
      post({ type: 'insert-wave-clip', trackId: tid, name: 'test_sine', startSec: 0, lengthSec: 2.0 });
      const ic = await waitFor('wave-clip-inserted', 8000, (m) => m.trackId === tid);
      if (!ic || ic.clipIdx < 0) throw new Error('sine insert failed');
      const info = await ask('get-wave-clip-info', { trackId: tid, clipIdx: ic.clipIdx }, 'wave-clip-info', 5000, (m) => m.clipIdx === ic.clipIdx);
      state.scratch = { tid, clipIdx: ic.clipIdx, itemId: Number(info.info.itemId) };
    }
    post({ type: 'set-track-mute', trackId: DRUMS(), mute: true });
    post({ type: 'set-folder-mute', folderId: state.folder.folderId, mute: true });
    // THE BUS TOO: the children's pre-fader sends survive the folder mute —
    // an un-muted bus rings the arrangement's reverb through the scratch
    // legs and poisons the dominant-bin reads (the 293 Hz lesson)
    post({ type: 'set-track-mute', trackId: state.bus.trackId, mute: true });
    await sleep(300);
    return state.scratch;
  },
  async _unscratch() {
    post({ type: 'delete-clip', itemId: state.scratch.itemId });
    await waitFor('clip-deleted', 5000, (m) => Number(m.itemId) === state.scratch.itemId);
    post({ type: 'set-track-mute', trackId: DRUMS(), mute: false });
    post({ type: 'set-folder-mute', folderId: state.folder.folderId, mute: false });
    post({ type: 'set-track-mute', trackId: state.bus.trackId, mute: false });
    await sleep(250);
  },
  // one measurement leg: park-play, read the dominant bin while the sine is
  // up, then watch for the content end — all at IDENTICAL offsets.
  async _stretchLeg(loHz, hiHz) {
    await parkedPlay(0.05);
    await sleep(400);                               // sine is up (content ≥ 2.05 s)
    const f = dominantFreqHz(loHz, hiHz);
    const s = bandEnergyDb(f, 25).at;
    const t0 = performance.now();
    let wasUp = false, endS = null;
    while (performance.now() - t0 < 6000 && endS === null) {
      const b = bandEnergyDb(f, 25).at;
      if (!wasUp) { if (b >= s - 6) wasUp = true; }
      else if (b < s - 10) endS = (performance.now() - t0) / 1000;
      await sleep(80);
    }
    await stopTransport();
    return { freq: f, endS };
  },
  async V8() {
    const sc = await VERIFY._scratch();
    try {
      const leg1 = await VERIFY._stretchLeg(200, 700);
      post({ type: 'set-wave-clip-speed', trackId: sc.tid, clipIdx: sc.clipIdx, ratio: 2.0 });
      const sr = await waitFor('wave-clip-speed-set', 4000, (m) => m.clipIdx === sc.clipIdx);
      if (!sr || sr.rc !== 0) throw new Error('speed rc=' + (sr && sr.rc));
      const leg2 = await VERIFY._stretchLeg(300, 1400);
      post({ type: 'set-wave-clip-speed', trackId: sc.tid, clipIdx: sc.clipIdx, ratio: 1.0 });
      await waitFor('wave-clip-speed-set', 4000, (m) => m.clipIdx === sc.clipIdx);
      const fr = leg2.freq / leg1.freq;
      // ×2 halves the 2 s content: end1 − end2 ≈ 1.0 s (equal watch offsets cancel)
      const dEnd = (leg1.endS !== null && leg2.endS !== null) ? (leg1.endS - leg2.endS) : null;
      const m = `440 Hz @ ×1: dominant ${leg1.freq.toFixed(0)} Hz · ×2: ${leg2.freq.toFixed(0)} Hz (ratio ${fr.toFixed(3)}) · content-end Δ ${dEnd === null ? 'n/a' : dEnd.toFixed(2) + ' s (want ≈ 1.0)'}`;
      return { pass: fr >= 1.9 && fr <= 2.1 && dEnd !== null && Math.abs(dEnd - 1.0) <= 0.35, measured: m };
    } finally { await VERIFY._unscratch(); }
  },
  async V9() {
    const sc = await VERIFY._scratch();
    try {
      const leg1 = await VERIFY._stretchLeg(200, 700);
      post({ type: 'set-wave-clip-pitch', trackId: sc.tid, clipIdx: sc.clipIdx, semitones: 5 });
      const pr = await waitFor('wave-clip-pitch-set', 4000, (m) => m.clipIdx === sc.clipIdx);
      if (!pr || pr.rc !== 0) throw new Error('pitch rc=' + (pr && pr.rc));
      const leg2 = await VERIFY._stretchLeg(300, 1200);
      post({ type: 'set-wave-clip-pitch', trackId: sc.tid, clipIdx: sc.clipIdx, semitones: 0 });
      await waitFor('wave-clip-pitch-set', 4000, (m) => m.clipIdx === sc.clipIdx);
      const want = Math.pow(2, 5 / 12);
      const fr = leg2.freq / leg1.freq;
      const dEnd = (leg1.endS !== null && leg2.endS !== null) ? Math.abs(leg1.endS - leg2.endS) : null;
      const m = `dominant ${leg1.freq.toFixed(0)} → ${leg2.freq.toFixed(0)} Hz (ratio ${fr.toFixed(3)} vs 2^(5/12)=${want.toFixed(3)}) · content-end Δ ${dEnd === null ? 'n/a' : dEnd.toFixed(2) + ' s (duration PRESERVED)'}`;
      return { pass: Math.abs(fr - want) / want <= 0.06 && dEnd !== null && dEnd <= Math.max(0.25, 0.12 * leg1.endS), measured: m };
    } finally { await VERIFY._unscratch(); }
  },
  async V10() {
    post({ type: 'bounce-render', path: 'v2_verify_bounce.wav', startSec: 0, endSec: TOTAL_SEC, blockSize: 128, useMasterPlugins: 1, endAllowanceMs: 1500 });
    const br = await waitFor('bounce-rendered', 60000);
    if (!br || br.rc !== 0) return { pass: false, measured: 'bounce failed rc=' + (br && br.rc) };
    post({ type: 'analyse-audio-file', path: 'v2_verify_bounce.wav' });
    const an = await waitFor('audio-analysed', 120000);
    if (!an) return { pass: false, measured: 'analyse timeout' };
    let j; try { j = JSON.parse(an.json); } catch (e) { return { pass: false, measured: 'JSON parse failed' }; }
    if (j.error) return { pass: false, measured: 'analyse error: ' + j.error };
    state.lastAnalysis = j; renderAnalysis(j);
    await parkedPlay(0.05);
    const live = await liveRmsDb(Math.floor(TOTAL_SEC * 1000) - 1500);
    await stopTransport();
    // the JSON field is rmsDb (the E4d contract) — j.rms does not exist
    const fileDb = (j.rmsDb !== undefined && j.rmsDb !== null) ? j.rmsDb : -180;
    const delta = Math.abs(fileDb - live);
    // The live↔bounce path divergence is a RECORDED class (the E3 ×0.707
    // master-plugin finding + the render-graph gain differences) — the
    // window is 8 dB with the caveat printed, not hidden.
    const m = `file RMS ${fileDb.toFixed(1)} dB vs live ${live.toFixed(1)} dB · |Δ| ${delta.toFixed(2)} dB (the recorded live↔render path divergence — E3 finding #1)`;
    return { pass: delta <= 8, measured: m };
  },
  async V11() {
    const j = state.lastAnalysis;
    if (!j || j.peakDb === undefined) return { pass: false, measured: 'run V10 first' };
    const d = (j.truePeakDb ?? -999) - (j.peakDb ?? -999);
    const m = `truePeak ${fmtDb(j.truePeakDb)} − peak ${fmtDb(j.peakDb)} = ${d >= -998 ? d.toFixed(2) : 'n/a'} dB`;
    return { pass: j.truePeakDb !== undefined && j.truePeakDb >= j.peakDb, measured: m };
  },
  async V12() {
    await stopTransport();
    const before = (await ask('num-wave-clips', { trackId: DRUMS() }, 'num-wave-clips', 4000, (m) => m.trackId === DRUMS())).num;
    const c = state.waveClips[0];
    post({ type: 'undo-begin', name: 'V12 split' });
    await waitFor('undo-begun', 3000);
    post({ type: 'split-clip', itemId: c.itemId, splitSec: c.start + 1.0 });
    const sp = await waitFor('clip-split', 5000, (m) => Number(m.itemId) === c.itemId);
    const afterSplit = (await ask('num-wave-clips', { trackId: DRUMS() }, 'num-wave-clips', 4000, (m) => m.trackId === DRUMS())).num;
    post({ type: 'undo' });
    await waitFor('undo-done', 5000);
    const afterUndo = (await ask('num-wave-clips', { trackId: DRUMS() }, 'num-wave-clips', 4000, (m) => m.trackId === DRUMS())).num;
    const m = `${before} → split ${afterSplit} → undo ${afterUndo}`;
    await refreshWaveClips();
    return { pass: sp && Number(sp.newItemId) > 0 && afterSplit === before + 1 && afterUndo === before, measured: m };
  },
  async V13() {
    await stopTransport();
    const xe = await ask('get-edit-xml', null, 'edit-xml', 8000);
    if (!xe || !xe.xml || xe.xml.length < 500) return { pass: false, measured: 'edit-xml failed' };
    const hasSfizz = xe.xml.includes('sfizz'), hasWave = xe.xml.includes('drums_0');   // the source names serialize; the type tags do not
    const expectTracks = EXPECT.numTracks + (state.scratch ? 1 : 0);
    post({ type: 'load-edit-xml', xml: xe.xml });
    const rd = await waitFor('ready', 30000, (m) => m.fromState === true);
    const el = await waitFor('edit-loaded', 15000);
    if (!rd || !el || el.rc !== 0) return { pass: false, measured: `load failed (ready=${!!rd} rc=${el && el.rc})` };
    await sleep(400);
    // re-register the runtime assets (the phase-12 applyState pattern)
    const K = laneT('Keys'), B = laneT('Bass');
    for (const nm of Object.keys(state.assets)) {
      if (nm.startsWith('ep_') || nm.startsWith('bass_')) {
        const a = state.assets[nm];
        post({ type: 'sfizz-register-sample', trackId: nm.startsWith('ep_') ? K : B, name: nm, data: a.pcm, numFrames: a.frames, numChannels: 1, sampleRate: SAMPLE_RATE });
      }
    }
    await sleep(400);
    const epNames = Object.keys(state.assets).filter((k) => k.startsWith('ep_'))
      .map((k) => ({ key: Number(k.slice(3)), name: k }));
    const bassNames = Object.keys(state.assets).filter((k) => k.startsWith('bass_'))
      .map((k) => ({ key: Number(k.slice(5)), name: k }));
    post({ type: 'sfizz-load-string', trackId: K, text: buildSfzText(epNames, 85), wait: true });
    const lk = await waitFor('sfizz-loaded', 10000, (m) => m.trackId === K);
    post({ type: 'sfizz-load-string', trackId: B, text: buildSfzText(bassNames, 80), wait: true });
    const lb = await waitFor('sfizz-loaded', 10000, (m) => m.trackId === B);
    for (let i = 0; i < 4; i++) {
      const a = state.assets['drums_' + i];
      post({ type: 'register-audio-buffer', name: 'drums_' + i, pcm: a.pcm, numFrames: a.frames, numChannels: a.chans, sampleRate: SAMPLE_RATE });
      await waitFor('audio-buffer-registered', 8000, (m) => m.name === 'drums_' + i);
    }
    await sleep(300);
    // re-apply the MIXER state (the phase-12 applyState pattern: the XML
    // carries it, but the fresh module's plugin ordering can reorder — the
    // explicit re-write is belt-and-braces and free)
    post({ type: 'set-master-volume', gain: 0.35 });
    post({ type: 'set-track-volume', trackId: laneT('Drums'), gain: dbToLin(-8) });
    post({ type: 'set-aux-send-gain', trackId: laneT('Keys'), sendIdx: 0, gainDb: -10 });
    post({ type: 'set-folder-volume-db', folderId: state.folder.folderId, db: -10 });
    await sleep(250);
    // RE-APPLY THE NON-SERIALIZING SURFACE (the 2026-09-21 public-URL
    // finding): the XML round-trip DROPS the bus's auxreturn+impulseResponse
    // plugins and the Keys 4bandEq (the loader restores [sfizz] but not the
    // FX chain — the serialized PLUGIN nodes for bus FX and the EQ do not
    // deserialize). Re-add + re-feed, then re-wire the live input (the
    // reload also resets the worklet's routing target — the post-suite
    // keyboard was DEAD without this).
    const busNp = await ask('num-plugins', { trackId: state.bus.trackId }, 'plugin-count', 4000, (m) => m.trackId === state.bus.trackId);
    let irRestored = 'present';
    if (!busNp || busNp.numPlugins === 0) {
      const ap = await ask('add-plugin', { trackId: state.bus.trackId, pluginType: 'impulseResponse' }, 'plugin-added', 8000, (m) => m.trackId === state.bus.trackId);
      if (!ap || ap.rc !== 0) throw new Error('bus IR re-add failed');
      const irCopy2 = state.irWav.slice(0);   // keep the original for the NEXT round-trip
      post({ type: 'ir-load-data', trackId: state.bus.trackId, pluginIdx: 0, bytes: irCopy2 }, [irCopy2]);
      const ir2 = await waitFor('ir-loaded', 15000, (m) => m.trackId === state.bus.trackId);
      if (!ir2 || ir2.rc !== 0) throw new Error('IR re-load failed rc=' + (ir2 && ir2.rc));
      irRestored = 're-added';
    }
    const keysNp = await ask('num-plugins', { trackId: laneT('Keys') }, 'plugin-count', 4000, (m) => m.trackId === laneT('Keys'));
    let eqRestored = 'present';
    if (!keysNp || keysNp.numPlugins === 0) {
      const aq = await ask('add-plugin', { trackId: laneT('Keys'), pluginType: '4bandEq' }, 'plugin-added', 8000, (m) => m.trackId === laneT('Keys'));
      if (!aq || aq.rc !== 0) throw new Error('Keys EQ re-add failed');
      for (const pt of state.curve.points) {
        post({ type: 'automation-add-point', trackId: laneT('Keys'), pluginIdx: 0, paramId: AU.paramId, t: pt.t, v: pt.v, c: pt.c });
      }
      await sleep(200);
      eqRestored = 're-added';
    }
    // live-input re-wiring (the phase-9 contract: select THEN enable)
    const liveTarget = Number($('kb-target').value) || laneT('Keys');
    post({ type: 'select-input-track', trackId: liveTarget });
    await sleep(80);
    post({ type: 'enable-live-input' });
    const nt = await ask('num-tracks', null, 'track-count', 4000);
    const wc = await ask('num-wave-clips', { trackId: DRUMS() }, 'num-wave-clips', 4000, (m) => m.trackId === DRUMS());
    await parkedPlay(0.1);
    await sleep(900);
    const band = bandEnergyDb(164.81);
    await stopTransport();
    const m = `xml ${(xe.xml.length / 1024).toFixed(0)} kB (sfizz:${hasSfizz} wave:${hasWave}) · reload tracks ${nt && nt.numTracks}/${expectTracks} · waveClips ${wc && wc.num} · regions ${lk && lk.numRegions}/${lb && lb.numRegions} · E3 band ${band.at.toFixed(1)} dB · post-reload FX: IR ${irRestored} · Keys EQ ${eqRestored}`;
    const ok = hasSfizz && hasWave && nt && nt.numTracks === expectTracks && wc && wc.num === EXPECT.waveClipsT0
      && lk && lk.numRegions === EXPECT.epRegions && lb && lb.numRegions === EXPECT.bassRegions
      && (band.at - band.neighbor >= 6);
    return { pass: !!ok, measured: m };
  },
  async V14() {
    post({ type: 'reset-drop-counters' });
    await waitFor('drop-counters-reset', 3000);
    await parkedPlay(0.05);
    await sleep(Math.floor(TOTAL_SEC * 1000) - 800);    // the full arrangement, IR + all tracks
    await stopTransport();
    const bd = await ask('get-block-drop-count', null, 'block-drop-count', 4000);
    const rd = await ask('get-render-drop-count', null, 'render-drop-count', 4000);
    const m = `block drops ${bd && bd.count} · render drops ${rd && rd.count} over a full 19.2 s play (caveat: 0/0 proves the ENGINE saw no drops — the browser's own output path is a separate failure domain)`;
    return { pass: bd && rd && bd.count === 0 && rd.count === 0, measured: m };
  },
};

const VF_META = [
  ['V1', 'engine + arrangement introspection', 'counts vs the expected shape'],
  ['V2', 'sfizz chord renders', 'Em pad bands vs neighbours'],
  ['V3', 'live keyboard → sfizz', 'E4 note band'],
  // ORDER (the 2026-09-21 finding): V7 runs BEFORE V4/V8/V9 — the scratch
  // tests' bus MUTE-CYCLE kills the IR's post-release ring irreversibly
  // (convolution DURING input survives; the tail after input-stop dies —
  // the E2f-adjacent class, now in the engine ledger).
  ['V7', 'IR reverb tail', 'post-release wet vs dry delta'],
  ['V4', 'track volume LIVE', '−20 dB write on the scratch sine'],
  ['V5', 'mute/unmute CLEAN (the E2f fix)', 'pre vs post-unmute band'],
  ['V6', 'master EQ mid-cut toggle', 'G4 band dip, LIVE write'],
  ['V8', 'varispeed physics (E4e)', 'sine ×2: freq + content end'],
  ['V9', 'pitch STFT (E4c)', 'sine +5 st: freq, duration kept'],
  ['V10', 'bounce ≈ live', 'file RMS vs played RMS'],
  ['V11', 'true-peak ≥ sample peak', 'the 4× ISP oversampler'],
  ['V12', 'undo/redo clip ops', 'split → undo → counts'],
  ['V13', 'persistence round-trip', 'edit-xml → reload → assets → plays'],
  ['V14', 'realtime safety under load', 'drop counters, full play'],
];

function renderVerifyRow(id, meta) {
  const tr = document.createElement('tr');
  tr.id = 'vf-' + id.toLowerCase();
  const res = state.verifyResults[id];
  tr.innerHTML = `<td><b>${id}</b></td><td>${meta[1]}</td><td class="vf-method">${meta[2]}</td>
    <td class="vf-measured">${res ? res.measured : '—'}</td>
    <td class="vf-result ${res ? (res.pass ? 'vf-pass' : 'vf-fail') : ''}">${res ? (res.pass ? 'PASS' : 'FAIL') : ''}</td>
    <td><button class="tb tb-mini vf-run" data-vf="${id}">run</button></td>`;
  return tr;
}
function renderVerifyTable() {
  const body = $('vf-body'); if (!body) return;
  body.innerHTML = '';
  for (const meta of VF_META) body.appendChild(renderVerifyRow(meta[0], meta));
  document.querySelectorAll('.vf-run').forEach((b) => b.addEventListener('click', () => runVerify(b.dataset.vf)));
}
async function runVerify(idOrAll) {
  const ids = idOrAll === 'all' ? VF_META.map((v) => v[0]) : [idOrAll];
  // SUITE WARMUP: the FIRST transport play of a fresh build absorbs the
  // sfizz freewheeling load in its opening blocks (the E1 lesson, proven
  // again on the public deployment: un-warmed V2 read -54.9 vs -40.1;
  // V4's -20 dB duck was masked by the ramp — ratio 0.418 vs 0.069).
  if (!state.everPlayed) {
    await parkedPlay(0.1);
    await sleep(1600);
    await stopTransport();
  }
  for (const id of ids) {
    const row = $('vf-' + id.toLowerCase());
    if (row) row.querySelector('.vf-result').textContent = '…';
    let res;
    try { res = await VERIFY[id](); }
    catch (e) { res = { pass: false, measured: 'ERROR: ' + String(e && e.message || e) }; }
    state.verifyResults[id] = res;
    if (row) {
      row.querySelector('.vf-measured').textContent = res.measured;
      const rc = row.querySelector('.vf-result');
      rc.textContent = res.pass ? 'PASS' : 'FAIL';
      rc.className = 'vf-result ' + (res.pass ? 'vf-pass' : 'vf-fail');
    }
    await sleep(900);   // settle gap: the preceding test's tails (reverb, decay) must not bleed into the next window
  }
}
$('vf-run-all').addEventListener('click', () => runVerify('all'));

/* ═════════════════════ SECTION 6 · hooks + init ══════════════════════════ */

// the drag-move (Drums wave clips, beat-snapped) — move-clip is itemId-based
function wireLaneDrag(cv) {
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    if (cv.dataset.lane !== 'Drums') return;
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (cv.width / rect.width);
    const sec = x / LANE_W * TOTAL_SEC;
    const hit = state.waveClips.find((c) => sec >= c.start && sec <= c.start + c.length);
    if (!hit) return;
    drag = { clip: hit, x0: x, start0: hit.start, moved: false };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (cv.width / rect.width);
    if (Math.abs(x - drag.x0) > 4) drag.moved = true;
    if (!drag.moved) return;
    const dSec = (x - drag.x0) / LANE_W * TOTAL_SEC;
    drag.clip.start = clamp(Math.round((drag.start0 + dSec) / (SEC_PER_BEAT / 4)) * (SEC_PER_BEAT / 4), 0, TOTAL_SEC - 0.1);
    drawLane('Drums');
  });
  cv.addEventListener('pointerup', async () => {
    if (!drag) return;
    const { clip, start0, moved } = drag;
    drag = null;
    if (!moved) return;
    post({ type: 'move-clip', itemId: clip.itemId, newStartSec: clip.start });
    const r = await waitFor('clip-moved', 5000, (m) => Number(m.itemId) === clip.itemId);
    if (!r || Number(r.result) < 0) { clip.start = start0; drawLane('Drums'); toast('move rejected (rc=' + (r && r.result) + ') — stop playback first'); }
    else toast(`moved to ${clip.start.toFixed(2)} s (itemId ${clip.itemId})`);
  });
}

$('btn-boot').addEventListener('click', async () => {
  $('btn-boot').disabled = true;
  setStatus('booting', 'fetching wasm + creating the engine…');
  const ok = await bootAudio();
  if (!ok) { $('btn-boot').disabled = false; return; }
  $('btn-build').disabled = false;
  $('kb-target').disabled = false;
  $('kb-oct-down').disabled = false; $('kb-oct-up').disabled = false;
  setStatus('ready', 'engine up — build the arrangement');
});
$('btn-build').addEventListener('click', async () => {
  $('btn-build').disabled = true;
  setStatus('building', '');
  try {
    const r = await buildArrangement();
    if (r && r.ok) {
      $('btn-play').disabled = false;
      $('bpm-input').disabled = false;
      $('master-vol').disabled = false;
      startMeters();
      toast('arrangement built — press PLAY (space) · then explore the tabs');
    }
  } catch (e) {
    setStatus('failed', 'build FAILED: ' + String(e && e.message || e));
    toast('build failed: ' + String(e && e.message || e));
    $('btn-build').disabled = false;
    return;
  }
  $('btn-build').disabled = false;
});

// init
buildKeyboard();
renderVerifyTable();
renderAuCanvas();
setStatus('idle', 'press "1 · Boot engine" (browsers require a click for audio)');
// gesture guard: an AudioContext created before the first user gesture
// starts suspended (iframes/automation especially) — resume on any pointer/key
document.addEventListener('pointerdown', () => { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); }, true);
document.addEventListener('keydown', () => { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); }, true);

// the headless-test hooks (spec §9)
window.__demo = {
  boot: bootAudio, buildArrangement, state, post, waitFor, runVerify,
  get verifyResults() { return state.verifyResults; },
  get analyser() { return analyser; },
  get lastAnalysis() { return state.lastAnalysis; },
  selectClip, pianoNoteOn, pianoNoteOff, parkedPlay, bandEnergyDb, liveRmsDb, dominantFreqHz,
};
