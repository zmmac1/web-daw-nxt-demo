// AudioWorklet processor for Tracktion Engine WASM — Phase 2
//
// Architecture:
//   - Main thread: loads WASM, calls _engine_create() for status display
//   - Worklet: uses Phase 1 API (_engine_init, _engine_load_audio_buffer,
//     _engine_play, _engine_process_block) for actual audio output
//
// The real Tracktion Engine (engine_create) works in Node.js but its 22 EM_ASM
// console.log calls + init sequence block the AudioWorklet's event loop,
// preventing process() from being called. Using the Phase 1 API in the worklet
// is reliable and proven.
//
// CRITICAL: AudioWorkletGlobalScope has NO fetch, URL, setTimeout, etc.
// The WASM binary MUST be fetched by the main thread and transferred.

import initEngine from './tracktion_engine_wasm.js';

// Polyfills for AudioWorkletGlobalScope (no performance, URL, timers).
//
// ROOT-CAUSE NOTES (Phase 6 browser-silence bugs — see phase5-processor.js
// for the full story):
//  1. performance.now() MUST be real wall-clock time. Returning audio
//     currentTime froze emscripten's clock whenever the worklet thread was
//     blocked, deadlocking nanosleep() inside Thread::sleep() (e.g.
//     DeviceManager::addContext during transport play).
//  2. setTimeout callbacks MUST NOT run as microtasks. YUP's
//     InternalMessageQueue starts an emscripten main loop during
//     engine_create; microtask-based timers then starve the worklet event
//     loop forever (no process(), no messages, total silence). Queue timer
//     callbacks and drain them at macrotask boundaries instead.
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Date.now() };
}
if (typeof globalThis.URL === 'undefined') {
  globalThis.URL = class { constructor(u) { this.href = u; } };
}
if (typeof globalThis.setTimeout === 'undefined') {
  const pendingTimers = [];
  const cancelledIds = new Set(); // same-drain-batch cancellations (R9 P2)
  let nextTimerId = 1;
  let draining = false;           // reentrancy guard (R9 P3)
  const nowMs = () => (typeof Date !== 'undefined' && Date.now ? Date.now() : 0);

  globalThis.__drainWorkletTimers = function () {
    if (draining || pendingTimers.length === 0) return;
    draining = true;
    cancelledIds.clear();
    try {
      const now = nowMs();
      const due = [];
      const keep = [];
      for (const t of pendingTimers) (t.due <= now ? due : keep).push(t);
      pendingTimers.length = 0;
      for (const t of keep) pendingTimers.push(t);
      // Run due callbacks AFTER re-filling the pending list so a callback can
      // clearTimeout/clearInterval itself (and so intervals re-arm correctly).
      for (const t of due) {
        // R9 P2: a clearTimeout() issued from another callback in THIS batch
        // must still cancel a not-yet-run due entry.
        if (t.cancelled || cancelledIds.has(t.id)) continue;
        if (t.interval) { t.due = now + t.interval; pendingTimers.push(t); }
        try { t.func(...t.args); } catch (e) { /* a bad timer must not kill audio */ }
      }
    } finally {
      draining = false;
      cancelledIds.clear();
    }
  };

  globalThis.setTimeout = function (func, delay, ...args) {
    const id = nextTimerId++;
    pendingTimers.push({ id, func, args, due: nowMs() + Math.max(0, Number(delay) || 0) });
    return id;
  };
  globalThis.clearTimeout = function (id) {
    const i = pendingTimers.findIndex((t) => t.id === id);
    if (i >= 0) { pendingTimers.splice(i, 1); return; }
    // Not queued: either already fired (no-op) or sitting in the CURRENT
    // drain's due batch — only the latter needs the cancelled marker.
    if (draining) cancelledIds.add(id);
  };
  globalThis.setInterval = function (func, delay, ...args) {
    const id = nextTimerId++;
    const interval = Math.max(1, Number(delay) || 1);
    pendingTimers.push({ id, func, args, due: nowMs() + interval, interval });
    return id;
  };
  globalThis.clearInterval = globalThis.clearTimeout;
}

class TracktionProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasmReady = false;
    this.samplesPtr = 0;
    this.maxBlockSize = 4096;
    this.numChannels = 2;
    this.lastPositionReport = 0;

    this.port.onmessage = (e) => {
      // Drain polyfilled timers at every macrotask boundary (parity with
      // phase5-processor.js — see the polyfill notes at the top of this file).
      if (typeof globalThis.__drainWorkletTimers === 'function') {
        globalThis.__drainWorkletTimers();
      }
      const msg = e.data;
      if (msg.type === 'init-wasm') {
        this.initWasm(msg.wasmBinary);
      } else if (this.wasmReady) {
        try {
          this.handleMessage(msg);
        } catch (err) {
          this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
        }
      } else {
        if (msg.type !== 'init-wasm') {
          this.port.postMessage({ type: 'error', message: `WASM not ready (dropped: ${msg.type})` });
        }
      }
    };
  }

  async initWasm(wasmBinary) {
    try {
      if (!wasmBinary || !(wasmBinary instanceof ArrayBuffer)) {
        throw new Error('init-wasm requires an ArrayBuffer');
      }
      const mod = await initEngine({
        locateFile: (path) => '',
        wasmBinary,
      });
      this.mod = mod;

      // Use Phase 1 init (reliable in AudioWorklet — no engine_create blocking)
      // The main thread separately calls _engine_create for status display.
      mod._engine_init(sampleRate, this.numChannels);

      // Allocate output buffer
      this.samplesPtr = mod._malloc(this.maxBlockSize * this.numChannels * 4);
      if (!this.samplesPtr) {
        this.port.postMessage({ type: 'error', message: 'WASM malloc failed for output buffer' });
        return;
      }

      this.wasmReady = true;
      this.port.postMessage({ type: 'ready', sampleRate: sampleRate, engineCreated: true });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: 'WASM init failed: ' + String(err && err.message || err) });
    }
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'set-gain':
        this.mod._engine_set_gain(msg.gain);
        break;
      case 'load-audio': {
        const { left, right, sampleRate: sr, numFrames } = msg;
        if (!left || numFrames <= 0) {
          this.port.postMessage({ type: 'load-result', success: false, error: 'invalid buffer' });
          return;
        }
        const numChannels = right ? 2 : 1;
        const totalFloats = numFrames * numChannels;
        if (totalFloats > 250000000) {
          this.port.postMessage({ type: 'load-result', success: false, error: `buffer too large` });
          return;
        }
        const ptr = this.mod._malloc(totalFloats * 4);
        if (!ptr) {
          this.port.postMessage({ type: 'load-result', success: false, error: 'malloc failed' });
          return;
        }
        const heapF32 = this.mod.HEAPF32;
        const offset = ptr >> 2;
        heapF32.set(left, offset);
        if (right) heapF32.set(right, offset + numFrames);
        const rc = this.mod._engine_load_audio_buffer(ptr, numFrames, numChannels, sr);
        this.mod._free(ptr);
        this.port.postMessage({
          type: 'load-result',
          success: rc === 0,
          duration: this.mod._engine_get_loaded_duration(),
          numChannels,
          numFrames,
          sampleRate: sr,
        });
        break;
      }
      case 'play':
        this.mod._engine_play();
        break;
      case 'stop':
        this.mod._engine_stop();
        break;
      case 'seek':
        this.mod._engine_set_play_position(msg.seconds);
        break;
      case 'clear':
        this.mod._engine_clear_audio_buffer();
        break;
      case 'note-on': {
        const freq = 440 * Math.pow(2, (msg.note - 69) / 12);
        this.mod._engine_set_frequency(freq);
        break;
      }
      case 'note-off':
        this.mod._engine_set_frequency(0);
        break;
      default:
        break;
    }
  }

  process(inputs, outputs, parameters) {
    try {
    // Drain polyfilled timers at every render quantum (macrotask boundary)
    // so the worklet event loop stays alive — see the polyfill notes at the
    // top of this file.
    if (typeof globalThis.__drainWorkletTimers === 'function') {
      globalThis.__drainWorkletTimers();
    }

    if (!this.wasmReady || !this.samplesPtr) return true;

    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const numChannels = Math.min(output.length, this.numChannels);
    const blockSize = output[0].length;

    if (blockSize > this.maxBlockSize) {
      for (let ch = 0; ch < numChannels; ch++) output[ch].fill(0);
      return true;
    }

    this.mod._engine_process_block(this.samplesPtr, blockSize);

    const heap = this.mod.HEAPF32;
    const ptr = this.samplesPtr / 4;

    // Copy from WASM heap to output + measure RMS level
    let sumSq = 0;
    let sampleCount = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const srcOffset = ptr + ch * blockSize;
      const dst = output[ch];
      for (let i = 0; i < blockSize; i++) {
        const s = heap[srcOffset + i];
        dst[i] = s;
        sumSq += s * s;
        sampleCount++;
      }
    }

    const now = currentTime;
    if (now - this.lastPositionReport > 0.1) {
      this.lastPositionReport = now;
      const pos = this.mod._engine_get_play_position();
      const dur = this.mod._engine_get_loaded_duration();
      const playing = this.mod._engine_is_playing();
      const rms = sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0;
      this.port.postMessage({
        type: 'position',
        position: pos,
        duration: dur,
        playing: playing === 1,
        rms: rms,
      });
    }

    return true;
    } catch (e) {
      // Parity with phase5-processor.js: a throw inside process() would REMOVE
      // this node from the audio graph (spec behaviour) -> permanent silence
      // with no diagnostic. Surface the error ONCE and keep the node alive.
      if (!this._processErrorReported) {
        this._processErrorReported = true;
        try {
          this.port.postMessage({ type: 'error', message: `process() threw: ${String((e && e.stack) || e)}` });
        } catch (_) {}
      }
      return true;
    }
  }
}

registerProcessor('tracktion-processor', TracktionProcessor);
