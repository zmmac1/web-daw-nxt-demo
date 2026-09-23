// phase5-processor.js — AudioWorklet processor for the Phase 5/6 demo
//
// Phase 6: REAL tracktion engine audio. The WASM engine now carries a
// FourOscPlugin synth on its track (engine_add_synth) so MIDI clips render
// to audio through HostedAudioDeviceInterface::processBlock — driven right
// here in process(). The JS sine-wave melody is kept ONLY as a fallback if
// the engine path produces silence (e.g. an older WASM build without the
// synth, or an engine-side regression), so the demo never goes fully mute.
//
// The real engine (engine_create, engine_add_synth, engine_transport_play,
// engine_process_block) also proves the P1-1 single-threaded fix works.
import initEngine from './tracktion_engine_wasm.js';

// ROOT-CAUSE NOTE (Phase 6 browser-silence bug #2): AudioWorkletGlobalScope
// has NO performance object (it is not part of the WorkletGlobalScope spec).
// The previous polyfill returned `currentTime * 1000` — AUDIO time, which
// only advances while the render graph is running. emscripten's clock
// (_emscripten_get_now -> performance.now) therefore FREEZES whenever the
// worklet thread is busy, so nanosleep() inside Thread::sleep() (called
// e.g. by DeviceManager::addContext during engine_transport_play) spins
// forever on a frozen clock — deadlocking the worklet (no process(), no
// messages, total silence). Node tests never saw this: Node has a native,
// always-advancing performance.now(). Date.now() DOES advance in the worklet
// even while the thread is blocked, so it is the correct time source here.
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Date.now() };
}
if (typeof globalThis.URL === 'undefined') {
  globalThis.URL = class { constructor(u) { this.href = u; } };
}
// Chromium's AudioWorkletGlobalScope has NO `crypto` — the emscripten glue's
// final random-fill fallback references it BARE (view=>(crypto.getRandomValues(view),0)).
// With the glue's ENVIRONMENT_IS_SHELL worklet carve-out, the d8 `os` branch is
// skipped and this final branch runs — without the polyfill the engine's FIRST
// Random call (setPitchChange / the bounce render task) throws
// "ReferenceError: crypto is not defined" INSIDE the wasm frame. Math.random
// is fine here (the engine's usage is non-cryptographic: IDs, dither).
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.getRandomValues) {
  globalThis.crypto = {
    getRandomValues: (view) => {
      for (let i = 0; i < view.length; i++) view[i] = (Math.random() * 256) | 0;
      return view;
    },
  };
}

// ============================================================================
// Timer polyfill for AudioWorkletGlobalScope (which has NO setTimeout etc.)
//
// ROOT-CAUSE NOTE (Phase 6 browser-silence bug): the previous version of this
// polyfill ran callbacks as MICROTASKS. That starves the worklet event loop
// forever once emscripten's main loop starts re-arming itself: YUP's
// InternalMessageQueue constructor calls emscripten_set_main_loop during
// engine_create, and each runner microtask schedules the next via this
// polyfilled setTimeout — an unbounded microtask chain that never yields,
// so port messages stop being delivered and process() is never called again
// (total silence, engine unreachable). Node tests never saw this because
// Node has a native setTimeout.
//
// Fix: queue timer callbacks and drain them at macrotask boundaries — every
// process() render quantum (~2.67ms @ 48k/128) and every port message — the
// closest thing to real timer semantics available inside an AudioWorklet.
// ============================================================================
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

// Melody in MIDI note numbers + beats (mirrors the MIDI clip in the engine).
// C5=72 E5=76 G5=79 C6=84
const MELODY = [
  { midi: 72, beats: 1 }, { midi: 76, beats: 1 },
  { midi: 79, beats: 1 }, { midi: 84, beats: 1 },
  { midi: 79, beats: 1 }, { midi: 76, beats: 1 },
  { midi: 72, beats: 2 },
];

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }


// UTF-8 encode WITHOUT TextEncoder — TextEncoder is NOT defined in
// AudioWorkletGlobalScope (the §5 restricted-globals lesson, re-learned
// 2026-09-02: engine_add_track's name argument threw ReferenceError and the
// tracks silently never existed while the page assumed they did).
// E2d i64 marshalling (the itemId boundary): the wasm i64 params take
// BigInt (the WebAssembly JS API rule; WASM_BIGINT is on in this build);
// the messages carry Numbers (itemIds < 2^53 — exact).
function toI64Worklet(v) {
  if (typeof v === 'bigint') return v;
  return BigInt(Math.trunc(Number(v) || 0));
}
function i64ToNumWorklet(v) {
  if (typeof v === 'bigint') return Number(v);
  return Number(v) || 0;
}

function utf8BytesWorklet(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.codePointAt(i);
    if (c > 0xffff) i++; // surrogate pair consumed by codePointAt
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

// E2e marshalling helpers (the undo-begin pattern extracted): cstrW
// mallocs + writes a NUL-terminated UTF-8 string; freeW frees (0-safe).
function cstrW(mod, str) {
  const bytes = utf8BytesWorklet(str);
  const ptr = mod._malloc(bytes.length + 1);
  if (!ptr) return 0;
  mod.HEAPU8.set(bytes, ptr);
  mod.HEAPU8[ptr + bytes.length] = 0;
  return ptr;
}
function freeW(mod, ptr) { if (ptr) mod._free(ptr); }

class Phase5Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasmReady = false;
    this.engineMode = false;      // true = real engine audio path active
    this.isPlaying = false;       // JS-fallback melody state
    this.sampleRate = 48000;
    this.bpm = 120;
    this.melodyFrame = 0;
    this.processCount = 0;
    this.liveNote = null;
    this.liveNoteFrame = 0;
    this.liveNoteDuration = 0;
    this.mod = null;
    this.outPtr = 0;
    this.maxBlockSize = 4096;
    this.numChannels = 2;
    this.lastPositionReport = 0;
    this.engineAudioBlocks = 0;   // blocks where engine path produced audio

    // Phase 8: the cached wasm binary + init options, so the engine can be
    // fully RE-INSTANTIATED in place (the "rebuild" path). The engine has
    // no engine_destroy / sequence-reset API (engine_create is idempotent:
    // `if (g_engine) return 0;`), so removing notes / changing BPM after a
    // clip exists / swapping instruments requires a fresh module instance.
    // Emscripten's factory creates a new WebAssembly.Memory per call; the
    // old module + heap become GC-eligible once dropped.
    this._wasmBinary = null;
    this._initOpts = { instrument: 'synth', loadMelody: true };
    this._rebuilding = false;
    // Phase 12: set by load-edit-xml — the pending edit-loaded reply flag
    // (posted after the re-init's 'ready' carries the loadRc).
    this._pendingEditLoaded = false;

    const totalBeats = MELODY.reduce((s, n) => s + n.beats, 0);
    this.totalMelodySec = totalBeats * (60 / this.bpm);

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'init-wasm') {
        if (this.wasmReady || this._rebuilding) {
          this.port.postMessage({ type: 'warn', message: 'init-wasm ignored: engine already initialized' });
          return;
        }
        this._wasmBinary = msg.wasmBinary;
        this._initOpts = {
          instrument: msg.instrument === 'sampler' ? 'sampler' : 'synth',
          loadMelody: msg.instrument === 'sampler' ? msg.loadMelody === true : msg.loadMelody !== false,
          // Phase 9: defer the init-time live-input wiring until the page has
          // selected its input target (select-input-track + enable-live-input
          // from applyStateToEngine). Dropped here before 2026-09-02 session 2 —
          // the flag never reached opts, so the input was ALWAYS wired at init
          // (the §6a.10 exemption baking onto track 0 by default).
          deferLiveInput: msg.deferLiveInput === true,
          // Phase 12: init-time state load (the page-reload flow). Consumed
          // ONCE by initWasm (cleared there) — later rebuild-engine calls
          // must not re-load the stale page-load XML.
          initialEditXml: (typeof msg.initialEditXml === 'string' && msg.initialEditXml.length > 0)
            ? msg.initialEditXml : null,
        };
        this.initWasm(this._wasmBinary, this._initOpts);
      }
      else if (this.wasmReady) { this.handleMessage(msg); }
    };
  }

  async initWasm(wasmBinary, opts = { instrument: 'synth', loadMelody: true }) {
    try {
      this.mod = await initEngine({
        wasmBinary, locateFile: (p) => './' + p, noExitRuntime: true,
      });
      this.wasmReady = true;

      // Reset per-instance diagnostics (the rebuild path re-enters here —
      // test assertions treat these as "since last ready").
      this.processCount = 0;
      this.engineAudioBlocks = 0;
      this.isPlaying = false;
      this.melodyFrame = 0;
      this.liveNote = null;
      this._liveInputRetryDue = false;

      // Allocate the stereo planar output buffer for engine_process_block
      this.outPtr = this.mod._malloc(this.maxBlockSize * this.numChannels * 4);
      if (!this.outPtr) {
        this.port.postMessage({ type: 'ready', engineCreated: false, error: 'malloc failed' });
        return;
      }

      // Full engine setup: create + instrument + live input routing.
      // All of this MUST happen before transport play so the playback
      // context's node graph is built WITH the instrument and MIDI targets.
      // Phase 12: a state-load init replaces engine_create with
      // engine_create_from_state_xml and SKIPS the instrument/melody
      // seeding — the loaded state carries its own plugin chains + clips
      // (instrumentOk = engineCreated: the state's tracks ARE the
      // instrument; the JS sine fallback must not mask a silent load).
      const fromState = typeof opts.initialEditXml === 'string' && opts.initialEditXml.length > 0;
      let loadRc = 0;
      let engineCreated = false;
      if (fromState) {
        if (typeof this.mod._engine_create_from_state_xml !== 'function') {
          this.port.postMessage({ type: 'warn', message: 'engine_create_from_state_xml missing (stale wasm?)' });
          loadRc = -999;
        } else {
          const bytes = utf8BytesWorklet(opts.initialEditXml);
          const ptr = this.mod._malloc(bytes.length + 1);
          if (!ptr) {
            loadRc = -998;
          } else {
            this.mod.HEAPU8.set(bytes, ptr);
            this.mod.HEAPU8[ptr + bytes.length] = 0;
            loadRc = this.mod._engine_create_from_state_xml(ptr, this.sampleRate, 2, 128);
            this.mod._free(ptr);
          }
        }
        engineCreated = loadRc === 0;
        // CONSUME-ONCE (the design §5): this option must never survive into
        // a later rebuild-engine — post-load edits would silently vanish.
        opts.initialEditXml = null;
      } else {
        const rcCreate = this.mod._engine_create(this.sampleRate, 2, 128);
        engineCreated = rcCreate === 0;
      }

      // Phase 8: instrument selection. 'sampler' = WasmSamplerPlugin (the
      // Phase 7 SFZ path; sounds are loaded via sampler-load-sound messages
      // AFTER this ready signal). 'synth' = the Phase 6 FourOscPlugin (the
      // legacy default — phase5-demo.html keeps working unchanged).
      const instrument = opts.instrument === 'sampler' ? 'sampler' : 'synth';
      let instrumentOk = false;
      if (engineCreated && !fromState) {
        if (instrument === 'sampler' && typeof this.mod._engine_add_wasm_sampler === 'function') {
          instrumentOk = this.mod._engine_add_wasm_sampler() === 0;
        } else if (instrument === 'synth' && typeof this.mod._engine_add_synth === 'function') {
          instrumentOk = this.mod._engine_add_synth() === 0;
        }
        if (instrumentOk && !opts.deferLiveInput
            && typeof this.mod._engine_enable_live_input === 'function') {
          const liveRc = this.mod._engine_enable_live_input();
          if (liveRc !== 0) {
            this.port.postMessage({ type: 'warn', message: `live input routing rc=${liveRc}` });
          }
        }
        // Phase 9: deferLiveInput — multi-track pages set the input target
        // FIRST (select-input-track) and then send 'enable-live-input'. The
        // input-target's mute-exemption is baked into the graph at build
        // time (§6a.3) — wiring track 0 here and re-targeting later leaves
        // track 0 exempt from mute/solo until a rebuild, and even a rebuild
        // re-wires track 0 first. Default (absent) = the Phase 6-8 behaviour.
        // Build the legacy hardcoded melody as a real MIDI clip (beats 0-8).
        // Only for the synth instrument (backward compat); the sampler page
        // owns its sequence dynamically via add-midi-clip/add-midi-note.
        if (instrument === 'synth' && opts.loadMelody && this.mod._engine_add_midi_clip(0, 8) === 0) {
          let beat = 0, notesOk = true;
          for (const note of MELODY) {
            if (this.mod._engine_add_midi_note(note.midi, 100, beat, note.beats) !== 0) notesOk = false;
            beat += note.beats;
          }
          if (!notesOk) this.port.postMessage({ type: 'warn', message: 'some melody notes failed' });
        } else if (instrument === 'synth' && opts.loadMelody) {
          this.port.postMessage({ type: 'warn', message: 'midi clip creation failed' });
        }
      }
      // Phase 12 (fromState): the loaded state's tracks/plugins ARE the
      // instrument — no seeding, and engineMode = engineCreated so a silent
      // load is visible as engine audio OFF, not masked by the JS sine.
      if (fromState) instrumentOk = engineCreated;
      // Real engine audio only if the instrument made it onto the track —
      // without it the engine renders MIDI to silence.
      this.engineMode = engineCreated && instrumentOk;

      // CodeRabbit R8 [0]: we run inside a realtime AudioWorklet — disable the
      // in-block timer pump (up to ~10ms of callbacks vs our 2.67ms block
      // budget) and pump from handleMessage instead (runs between quanta).
      if (this.engineMode && typeof this.mod._engine_set_realtime_mode === 'function') {
        this.mod._engine_set_realtime_mode(1);
      }

      this.port.postMessage({
        type: 'ready',
        engineCreated,
        instrument,
        synth: instrument === 'synth' ? instrumentOk : false,
        sampler: instrument === 'sampler' ? instrumentOk : false,
        engineAudio: this.engineMode,
        // Phase 12: the state-load init flags + the load rc (the page gates
        // its sound re-apply + live-input re-apply on these).
        fromState,
        loadRc: fromState ? loadRc : 0,
      });

      // Phase 12: the edit-loaded reply for the load-edit-xml flow (posted
      // AFTER 'ready'; the page's sound re-apply + live-input re-apply gate
      // on THIS message — it carries the loaded-track context).
      if (this._pendingEditLoaded) {
        this._pendingEditLoaded = false;
        let loadedNumTracks = 0;
        if (engineCreated && typeof this.mod._engine_get_num_tracks === 'function') {
          loadedNumTracks = this.mod._engine_get_num_tracks();
        } else {
          // The §6a.9/§6b silent-skip discipline (review 12-a F-4): a missing
          // export must warn, not silently report 0 tracks.
          this.port.postMessage({ type: 'warn', message: 'edit-loaded: num-tracks export missing (stale wasm?)' });
        }
        this.port.postMessage({
          type: 'edit-loaded',
          rc: fromState ? loadRc : -997,
          numTracks: loadedNumTracks,
        });
      }

      // Deferred live-input retry. engine_create's synchronous pumps can run
      // before the 5ms MIDI-rescan timer countdown has elapsed (the hosted
      // MIDI devices are then not created yet and enable_live_input returned
      // -2 above). A ~20ms polyfilled setTimeout only FLAGS the retry as due
      // (CodeRabbit: no engine side-effects inside the process() realtime
      // callback); the actual pump + retry run from handleMessage — between
      // render quanta — on the next incoming message. The page's 100ms
      // periodic pump guarantees that fires well before any human can click
      // Play, so the initial playback-context graph still includes the live
      // input destination.
      this._liveInputRetryDue = false;
      if (engineCreated && !opts.deferLiveInput && typeof globalThis.setTimeout === 'function') {
        globalThis.setTimeout(() => { this._liveInputRetryDue = true; }, 20);
      }
    } catch (e) {
      this.port.postMessage({ type: 'error', error: String(e) });
      // Consume-once must hold on the JS-error path too (review 12-a F-1):
      // a failed init must not leave a stale initialEditXml in _initOpts
      // for a later rebuild-engine to re-load.
      if (opts === this._initOpts) this._initOpts.initialEditXml = null;
    }
  }

  // Phase 8: full teardown + re-instantiation of the WASM engine from the
  // cached binary (see the constructor note for why reset-by-recreate is
  // the only option: engine_create is idempotent and there is no destroy /
  // sequence-clear export). Runs between render quanta (initiated from
  // handleMessage — never inside process()). The page re-applies its full
  // state after the new 'ready' message.
  async _rebuildEngine() {
    if (this._rebuilding) return;
    this._rebuilding = true;
    try {
      // Stop the old transport gracefully if it was playing, then drop the
      // module. The freed outPtr + dropped mod/heap become GC-eligible.
      // Review fix: also clear this.isPlaying — process() falls through to
      // the JS sine fallback whenever the engine is down, so a rebuild while
      // playing blipped the hardcoded fallback melody during the
      // re-instantiation window.
      this.isPlaying = false;
      if (this.mod) {
        try { this.mod._engine_transport_stop(); } catch (_) {}
        try { if (this.outPtr) this.mod._free(this.outPtr); } catch (_) {}
      }
      this.outPtr = 0;
      this.mod = null;
      this.wasmReady = false;
      this.engineMode = false;
      this._processErrorReported = false;
      // Give the worklet event loop a beat so process() observes mod=null and
      // falls through to silence instead of touching a freed heap mid-block.
      await new Promise((res) => { if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(res, 0); else res(); });
      await this.initWasm(this._wasmBinary, this._initOpts);
    } catch (e) {
      this.port.postMessage({ type: 'error', error: `rebuild-engine failed: ${String(e)}` });
      this._pendingEditLoaded = false; // no stale edit-loaded on a later init
    } finally {
      // Belt-and-braces consume-once (review 12-a F-1): whatever happened,
      // the rebuild consumed whatever stash was intended for it.
      this._initOpts.initialEditXml = null;
      this._rebuilding = false;
    }
  }

  handleMessage(msg) {
    // Drain polyfilled timers at every macrotask boundary (see the timer
    // polyfill note at the top of this file). This runs between render
    // quanta — never inside the audio callback — so it is also the safe
    // place to pump the YUP timer queue while realtime mode is on.
    if (typeof globalThis.__drainWorkletTimers === 'function') {
      globalThis.__drainWorkletTimers();
    }
    // Deferred live-input retry (see initWasm): run the pump + retry here,
    // between quanta, once the timer has flagged it due.
    if (this._liveInputRetryDue && this.mod) {
      this._liveInputRetryDue = false;
      try {
        if (typeof this.mod._engine_pump_message_loop === 'function') {
          this.mod._engine_pump_message_loop();
        }
        if (typeof this.mod._engine_enable_live_input === 'function') {
          const rc = this.mod._engine_enable_live_input();
          this.port.postMessage({
            type: 'warn',
            message: rc === 0 ? 'live input retry: OK' : `live input retry rc=${rc}`,
          });
        }
      } catch (e) {
        this.port.postMessage({ type: 'warn', message: `live input retry threw: ${String(e)}` });
      }
    }
    // CodeRabbit R8 [0]: this handler runs on the worklet thread BETWEEN
    // render quantums (never inside the audio callback), so it is the safe
    // place to pump the YUP timer queue while realtime mode is on.
    if (this.mod && typeof this.mod._engine_pump_message_loop === 'function') {
      try { this.mod._engine_pump_message_loop(); } catch (_) { /* keep audio alive */ }
    }
    switch (msg.type) {
      case 'set-bpm':
        this.bpm = msg.bpm;
        this.totalMelodySec = MELODY.reduce((s, n) => s + n.beats, 0) * (60 / this.bpm);
        if (this.mod) this.mod._engine_set_bpm(msg.bpm);
        break;
      case 'transport-play':
        this.isPlaying = true;
        this.melodyFrame = 0;
        if (this.mod) {
          // RE-ASSERT THE LAST SEEKED POSITION (the deterministic-replay
          // fix, TransportControl.cpp:1086): the 1-arg setPosition only sets
          // the transport's LOGICAL position + arms a 200ms 'lastUserDragTime'
          // guard — after 200ms the transport's poller (driven by OUR pump)
          // OVERWRITES position from the live playhead. A browser seek→play
          // pair separated by >200ms (a param round-trip, a UI pause) would
          // resume from the STALE playhead, not the seek target — the
          // section taps then land at run-dependent timeline points (the
          // E2b G-A/G-F flake). Re-posting the position microseconds before
          // play() arms the guard fresh; the play consumes it deterministically.
          if (this.lastSeekSeconds != null
              && typeof this.mod._engine_transport_set_position === 'function') {
            try { this.mod._engine_transport_set_position(this.lastSeekSeconds); } catch (_) {}
          }
          // Phase 8 deterministic-play hardening: on rare fresh-instance
          // runs play() returns 0 but the transport never engages (is_playing
          // stays 0 — total silence, no error). Pump + re-play until the flag
          // flips; bounded and cheap. (Empirically the post-create pump +
          // enable_live_input at init make this a no-op belt-and-braces.)
          let engaged = false;
          try { engaged = this.mod._engine_transport_is_playing() === 1; } catch (_) {}
          for (let i = 0; i < 10 && !engaged; i++) {
            this.mod._engine_transport_play();
            if (typeof this.mod._engine_pump_message_loop === 'function') {
              try { this.mod._engine_pump_message_loop(); } catch (_) {}
            }
            try { engaged = this.mod._engine_transport_is_playing() === 1; } catch (_) {}
          }
        }
        break;
      case 'transport-stop':
        this.isPlaying = false;
        if (this.mod) this.mod._engine_transport_stop();
        break;
      case 'seek':
        // Position the transport (seconds). Used by tests to make replay
        // deterministic; safe to expose for future UI seek controls.
        // The position is RE-ASSERTED at the next transport-play (the
        // 200ms poller race — see the transport-play case).
        this.lastSeekSeconds = msg.seconds || 0;
        if (this.mod && typeof this.mod._engine_transport_set_position === 'function') {
          try { this.mod._engine_transport_set_position(this.lastSeekSeconds); } catch (_) {}
        }
        break;
      case 'note-on':
        // Live note: engine path feeds the hosted MIDI device (routed to the
        // synth); JS fallback synthesises a 0.5s tone.
        if (this.mod && this.engineMode) this.mod._engine_note_on(msg.note, msg.velocity);
        this.liveNote = msg.note;
        this.liveNoteFrame = 0;
        this.liveNoteDuration = 0.5 * this.sampleRate;
        break;
      case 'note-off':
        if (this.mod && this.engineMode) this.mod._engine_note_off(msg.note);
        this.liveNote = null;
        break;
      case 'add-midi-clip':
        // Phase 8: dynamic sequence building (the piano-roll page owns the
        // note state; these push it into the engine's first MidiClip).
        // Phase 9: optional msg.trackId targets a specific track (default 0).
        if (this.mod) {
          const trackId = msg.trackId | 0 || 0;
          const fn = typeof this.mod._engine_add_midi_clip_on_track === 'function'
            ? this.mod._engine_add_midi_clip_on_track
            : null;
          const rc = fn
            ? fn(trackId, msg.startBeat || 0, msg.lengthBeats || 4)
            : this.mod._engine_add_midi_clip(msg.startBeat || 0, msg.lengthBeats || 4);
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `add-midi-clip rc=${rc} (track ${trackId})` });
        }
        break;
      case 'add-midi-note':
        // Pitch clamp + rc report keep the contract visible to the page.
        // Phase 9: optional msg.trackId targets a specific track (default 0).
        if (this.mod) {
          const p = Math.max(0, Math.min(127, msg.pitch | 0));
          const v = Math.max(1, Math.min(127, msg.velocity | 0 || 100));
          const trackId = msg.trackId | 0 || 0;
          const fn = typeof this.mod._engine_add_midi_note_on_track === 'function'
            ? this.mod._engine_add_midi_note_on_track
            : null;
          const rc = fn
            ? fn(trackId, p, v, msg.startBeat || 0, msg.lengthBeats || 1)
            : this.mod._engine_add_midi_note(p, v, msg.startBeat || 0, msg.lengthBeats || 1);
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `add-midi-note rc=${rc} (pitch ${p}, track ${trackId})` });
        }
        break;
      case 'sampler-load-sound':
        // Phase 8: load one sound into the WasmSamplerPlugin. Copies the
        // Float32Array into the WASM heap, then frees the scratch buffer —
        // the engine copies internally.
        // LAYOUT CONTRACT (review fix — the old comment said "interleaved"):
        // engine_wasm_sampler_load_sound expects PLANAR channel layout —
        // channel N's frames start at data + N*numFrames (NOT frame-
        // interleaved). All current callers send mono (numChannels=1) where
        // the distinction is moot. A stereo caller MUST lay out
        // [ch0 frames..., ch1 frames...].
        if (this.mod && typeof this.mod._engine_wasm_sampler_load_sound === 'function') {
          try {
            const data = msg.data; // Float32Array, PLANAR layout (see above)
            const frames = msg.numFrames | 0;
            const chans = Math.max(1, msg.numChannels | 0 || 1);
            if (!(data instanceof Float32Array) || data.length < frames * chans) {
              this.port.postMessage({ type: 'warn', message: 'sampler-load-sound: bad data payload' });
              break;
            }
            const bytes = frames * chans * 4;
            const ptr = this.mod._malloc(bytes);
            if (!ptr) {
              this.port.postMessage({ type: 'warn', message: 'sampler-load-sound: heap malloc failed' });
              break;
            }
            this.mod.HEAPF32.set(data.subarray(0, frames * chans), ptr >> 2);
            // Phase 9: optional msg.trackId targets a specific track's sampler
            // (default 0 = the legacy single-track sampler).
            const trackId = msg.trackId | 0 || 0;
            const fn = typeof this.mod._engine_wasm_sampler_load_sound_on_track === 'function'
              ? this.mod._engine_wasm_sampler_load_sound_on_track
              : null;
            const rc = fn
              ? fn(trackId,
                   msg.rootNote | 0, msg.minNote | 0, msg.maxNote | 0,
                   Math.max(1, msg.minVel | 0 || 1), Math.min(127, Math.max(1, msg.maxVel | 0 || 127)),
                   ptr, frames, chans, msg.sampleRate | 0 || this.sampleRate)
              : this.mod._engine_wasm_sampler_load_sound(
                   msg.rootNote | 0, msg.minNote | 0, msg.maxNote | 0,
                   Math.max(1, msg.minVel | 0 || 1), Math.min(127, Math.max(1, msg.maxVel | 0 || 127)),
                   ptr, frames, chans, msg.sampleRate | 0 || this.sampleRate);
            this.mod._free(ptr);
            const total = (typeof this.mod._engine_wasm_sampler_num_sounds === 'function')
              ? this.mod._engine_wasm_sampler_num_sounds() : -1;
            this.port.postMessage({ type: 'sampler-sound-loaded', rc, numSounds: total });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `sampler-load-sound threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'sampler-load-sound: no sampler on this engine' });
        }
        break;
      case 'sampler-num-sounds':
        if (this.mod && typeof this.mod._engine_wasm_sampler_num_sounds === 'function') {
          // Phase 9: optional msg.trackId (default 0 = the legacy sampler).
          const trackId = msg.trackId | 0 || 0;
          const fn = typeof this.mod._engine_wasm_sampler_num_sounds_on_track === 'function'
            ? this.mod._engine_wasm_sampler_num_sounds_on_track
            : null;
          const n = fn ? fn(trackId) : this.mod._engine_wasm_sampler_num_sounds();
          this.port.postMessage({ type: 'sampler-status', numSounds: n, trackId });
        }
        break;
      // ==== Phase 9: multi-track + mixing ====
      // Structural messages (add-track / add-wasm-sampler) are insert-only and
      // must be sent BEFORE the first transport-play (the graph builds at that
      // point — the same constraint as the Phase 8 sequence messages).
      case 'add-track':
        if (this.mod && typeof this.mod._engine_add_track === 'function') {
          try {
            const bytes = utf8BytesWorklet(String(msg.name || ''));
            const ptr = this.mod._malloc(bytes.length + 1);
            if (!ptr) { this.port.postMessage({ type: 'warn', message: 'add-track: malloc failed' }); break; }
            this.mod.HEAPU8.set(bytes, ptr);
            this.mod.HEAPU8[ptr + bytes.length] = 0;
            const trackId = this.mod._engine_add_track(ptr);
            this.mod._free(ptr);
            this.port.postMessage({ type: 'track-added', trackId, numTracks: this.mod._engine_get_num_tracks() });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `add-track threw: ${String(e)}` });
          }
        } else {
          // Silent-skip lesson (2026-09-02): a stale cached wasm made this
          // case fall through invisibly while the page assumed 3 tracks.
          this.port.postMessage({ type: 'warn', message: 'add-track: engine exports missing (stale wasm?)' });
        }
        break;
      case 'num-tracks':
        if (this.mod && typeof this.mod._engine_get_num_tracks === 'function') {
          this.port.postMessage({ type: 'track-count', numTracks: this.mod._engine_get_num_tracks() });
        }
        break;
      case 'add-wasm-sampler':
        // Phase 9: per-track sampler (msg.trackId; default 0). Idempotent.
        if (this.mod && typeof this.mod._engine_add_wasm_sampler_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const rc = this.mod._engine_add_wasm_sampler_on_track(trackId);
          this.port.postMessage({ type: 'wasm-sampler-added', trackId, rc });
        }
        break;
      case 'set-track-volume':
        if (this.mod && typeof this.mod._engine_set_track_volume === 'function') {
          const rc = this.mod._engine_set_track_volume(msg.trackId | 0, +msg.gain || 0);
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `set-track-volume rc=${rc}` });
        }
        break;
      case 'set-track-pan':
        if (this.mod && typeof this.mod._engine_set_track_pan === 'function') {
          const rc = this.mod._engine_set_track_pan(msg.trackId | 0, Math.max(-1, Math.min(1, +msg.pan || 0)));
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `set-track-pan rc=${rc}` });
        }
        break;
      case 'set-track-mute':
        if (this.mod && typeof this.mod._engine_set_track_mute === 'function') {
          const rc = this.mod._engine_set_track_mute(msg.trackId | 0, msg.mute ? 1 : 0);
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `set-track-mute rc=${rc}` });
        }
        break;
      case 'set-track-solo':
        if (this.mod && typeof this.mod._engine_set_track_solo === 'function') {
          const rc = this.mod._engine_set_track_solo(msg.trackId | 0, msg.solo ? 1 : 0);
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `set-track-solo rc=${rc}` });
        }
        break;
      case 'set-master-volume':
        if (this.mod && typeof this.mod._engine_set_master_volume === 'function') {
          const rc = this.mod._engine_set_master_volume(+msg.gain || 0);
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `set-master-volume rc=${rc}` });
        }
        break;
      case 'get-output-level':
        if (this.mod && typeof this.mod._engine_get_output_level === 'function') {
          this.port.postMessage({ type: 'output-level', level: this.mod._engine_get_output_level() });
        }
        break;
      case 'enable-live-input':
        // Phase 9: explicit live-input wiring for deferLiveInput pages — the
        // page has already set the input target (select-input-track). If the
        // hosted MIDI device isn't ready yet (the §6a.2 warm-instance case),
        // flag the deferred retry (the polyfilled-timer path re-runs it from
        // handleMessage) and report the pending rc.
        if (this.mod && typeof this.mod._engine_enable_live_input === 'function') {
          try {
            const rc = this.mod._engine_enable_live_input();
            if (rc !== 0 && typeof globalThis.setTimeout === 'function') {
              this._liveInputRetryDue = true; // retried by the handler preamble
            }
            this.port.postMessage({ type: 'live-input-enabled', rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `enable-live-input threw: ${String(e)}` });
          }
        }
        break;
      case 'select-input-track':
        // Phase 9: live MIDI (note-on/off + the on-screen keyboard) routes to
        // the selected track. Best sent before the first play; if live input
        // is already enabled the destination is re-wired immediately.
        if (this.mod && typeof this.mod._engine_set_input_track === 'function') {
          const rc = this.mod._engine_set_input_track(msg.trackId | 0);
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `select-input-track rc=${rc}` });
        }
        break;
      // ==== Phase 10: basic effects (WasmEQPlugin, baked-in) ====
      // Structural (add-eq) is insert-only: send BEFORE the first
      // transport-play (same constraint as add-track / add-wasm-sampler).
      // Parameter writes (set-eq-band) are LIVE per-block — no rebuild.
      case 'add-eq':
        if (this.mod && typeof this.mod._engine_add_eq_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const rc = this.mod._engine_add_eq_on_track(trackId);
          this.port.postMessage({ type: 'eq-added', trackId, rc });
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `add-eq rc=${rc} (track ${trackId})` });
        } else {
          this.port.postMessage({ type: 'warn', message: 'add-eq: engine exports missing (stale wasm?)' });
        }
        break;
      case 'has-eq':
        if (this.mod && typeof this.mod._engine_has_eq_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          this.port.postMessage({ type: 'eq-status', trackId, hasEQ: this.mod._engine_has_eq_on_track(trackId) });
        } else {
          // PR #4 review (§6a.9 always-else-warn): a stale wasm made this
          // fall through invisibly — the page's hasEq() then burns its full
          // 3s timeout and resolves null with no hint at the cause.
          this.port.postMessage({ type: 'warn', message: 'has-eq: engine exports missing (stale wasm?)' });
        }
        break;
      case 'set-eq-band':
        // band: 0 low-shelf / 1 peak / 2 high-shelf; freq Hz, gain dB, Q.
        // The engine clamps (20..20k, ±24dB, 0.1..18); live per block.
        if (this.mod && typeof this.mod._engine_set_eq_band_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const band = msg.band | 0;
          const rc = this.mod._engine_set_eq_band_on_track(
            trackId, band, +msg.freq || 1000, +msg.gain || 0, +msg.q || 0.707);
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `set-eq-band rc=${rc} (track ${trackId}, band ${band})` });
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-eq-band: engine exports missing (stale wasm?)' });
        }
        break;
      case 'get-eq-param':
        if (this.mod && typeof this.mod._engine_get_eq_param_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const value = this.mod._engine_get_eq_param_on_track(trackId, msg.band | 0, msg.param | 0);
          this.port.postMessage({ type: 'eq-param', trackId, band: msg.band | 0, param: msg.param | 0, value });
        } else {
          // PR #4 review (§6a.9): same stale-wasm else-warn discipline.
          this.port.postMessage({ type: 'warn', message: 'get-eq-param: engine exports missing (stale wasm?)' });
        }
        break;
      // ==== Phase E1: sfizz (the real SFZ sampler) ====
      // Structural (add-sfizz) is insert-only: BEFORE the first
      // transport-play (the same constraint as add-eq / add-wasm-sampler).
      // Register samples BEFORE sfizz-load-string (sfizz drops regions
      // whose sample file is missing at parse time — the ordering contract).
      case 'add-sfizz':
        if (this.mod && typeof this.mod._engine_add_sfizz_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const rc = this.mod._engine_add_sfizz_on_track(trackId);
          this.port.postMessage({ type: 'sfizz-added', trackId, rc });
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `add-sfizz rc=${rc} (track ${trackId})` });
        } else {
          this.port.postMessage({ type: 'warn', message: 'add-sfizz: engine exports missing (stale wasm? — E1 build required)' });
        }
        break;
      case 'has-sfizz':
        if (this.mod && typeof this.mod._engine_has_sfizz_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          this.port.postMessage({ type: 'sfizz-status', trackId, hasSfizz: this.mod._engine_has_sfizz_on_track(trackId) });
        } else {
          this.port.postMessage({ type: 'warn', message: 'has-sfizz: engine exports missing (stale wasm? — E1 build required)' });
        }
        break;
      case 'sfizz-register-sample':
        // data: Float32Array, PLANAR layout ([ch0 frames..., ch1 frames...]
        // — the sampler-load-sound contract; the engine WAV-writes
        // interleaved). name: a bare file name (no '/', no '..').
        if (this.mod && typeof this.mod._engine_sfizz_register_sample_on_track === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const data = msg.data;
            const frames = msg.numFrames | 0;
            const chans = Math.max(1, msg.numChannels | 0 || 1);
            if (!(data instanceof Float32Array) || data.length < frames * chans) {
              this.port.postMessage({ type: 'warn', message: 'sfizz-register-sample: bad data payload' });
              break;
            }
            const bytes = frames * chans * 4;
            const ptr = this.mod._malloc(bytes);
            if (!ptr) {
              this.port.postMessage({ type: 'warn', message: 'sfizz-register-sample: heap malloc failed' });
              break;
            }
            this.mod.HEAPF32.set(data.subarray(0, frames * chans), ptr >> 2);
            const nameBytes = utf8BytesWorklet(String(msg.name || ''));
            const nptr = this.mod._malloc(nameBytes.length + 1);
            if (!nptr) { this.mod._free(ptr); this.port.postMessage({ type: 'warn', message: 'sfizz-register-sample: name malloc failed' }); break; }
            this.mod.HEAPU8.set(nameBytes, nptr);
            this.mod.HEAPU8[nptr + nameBytes.length] = 0;
            const rc = this.mod._engine_sfizz_register_sample_on_track(
              trackId, nptr, ptr, frames, chans, msg.sampleRate | 0 || this.sampleRate);
            this.mod._free(nptr);
            this.mod._free(ptr);
            this.port.postMessage({ type: 'sfizz-sample-registered', trackId, rc,
              numSamples: this.mod._engine_sfizz_num_samples_on_track(trackId) });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `sfizz-register-sample threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'sfizz-register-sample: engine exports missing (stale wasm? — E1 build required)' });
        }
        break;
      case 'sfizz-load-string':
        // text: the SFZ definition (string). wait: 1 = keep freewheeling on
        // (offline determinism; the load wait lands in the first render
        // block — sfizz 1.2.3 semantics). TextEncoder is UNDEFINED in
        // AudioWorkletGlobalScope (§6a.9) — route through utf8BytesWorklet.
        if (this.mod && typeof this.mod._engine_sfizz_load_string_on_track === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const bytes = utf8BytesWorklet(String(msg.text || ''));
            const ptr = this.mod._malloc(bytes.length + 1);
            if (!ptr) { this.port.postMessage({ type: 'warn', message: 'sfizz-load-string: malloc failed' }); break; }
            this.mod.HEAPU8.set(bytes, ptr);
            this.mod.HEAPU8[ptr + bytes.length] = 0;
            const rc = this.mod._engine_sfizz_load_string_on_track(trackId, ptr, msg.wait ? 1 : 0);
            this.mod._free(ptr);
            const numRegions = (typeof this.mod._engine_sfizz_num_regions_on_track === 'function')
              ? this.mod._engine_sfizz_num_regions_on_track(trackId) : -1;
            this.port.postMessage({ type: 'sfizz-loaded', trackId, rc, numRegions });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `sfizz-load-string threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'sfizz-load-string: engine exports missing (stale wasm? — E1 build required)' });
        }
        break;
      case 'sfizz-num-samples':
        if (this.mod && typeof this.mod._engine_sfizz_num_samples_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          this.port.postMessage({ type: 'sfizz-sample-count', trackId,
            numSamples: this.mod._engine_sfizz_num_samples_on_track(trackId) });
        } else {
          this.port.postMessage({ type: 'warn', message: 'sfizz-num-samples: engine exports missing (stale wasm? — E1 build required)' });
        }
        break;
      case 'sfizz-num-regions':
        if (this.mod && typeof this.mod._engine_sfizz_num_regions_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          this.port.postMessage({ type: 'sfizz-region-count', trackId,
            numRegions: this.mod._engine_sfizz_num_regions_on_track(trackId) });
        } else {
          this.port.postMessage({ type: 'warn', message: 'sfizz-num-regions: engine exports missing (stale wasm? — E1 build required)' });
        }
        break;
      case 'sfizz-clear-samples':
        if (this.mod && typeof this.mod._engine_sfizz_clear_samples_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const rc = this.mod._engine_sfizz_clear_samples_on_track(trackId);
          this.port.postMessage({ type: 'sfizz-samples-cleared', trackId, rc });
        } else {
          this.port.postMessage({ type: 'warn', message: 'sfizz-clear-samples: engine exports missing (stale wasm? — E1 build required)' });
        }
        break;
      // ==== Phase E2a: the generic plugin surface ====
      // One message set over the engine's own 7 effect types. Strings
      // (type/paramId/prop) via utf8BytesWorklet (TextEncoder is UNDEFINED
      // in AudioWorkletGlobalScope, §6a.9); string RETURNS via
      // UTF8ToString on the STATIC buffer (never freed — the edit-xml
      // contract). add/remove/move are PRE-PLAY ops: the wrapper rejects
      // them with -4 while the transport is playing; param/property/
      // bypass writes are LIVE mid-play.
      case 'add-plugin':
        // NOTE: the effect type rides `pluginType` — a `type` field here
        // would SHADOW the message discriminant (a duplicate key in the
        // page's object literal: the message became '4bandEq' and dropped
        // silently at the switch — found via diag_e2a_browser.py).
        if (this.mod && typeof this.mod._engine_add_plugin_on_track === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const typeBytes = utf8BytesWorklet(String(msg.pluginType || ''));
            const tptr = this.mod._malloc(typeBytes.length + 1);
            if (!tptr) { this.port.postMessage({ type: 'warn', message: 'add-plugin: malloc failed' }); break; }
            this.mod.HEAPU8.set(typeBytes, tptr);
            this.mod.HEAPU8[tptr + typeBytes.length] = 0;
            const rc = this.mod._engine_add_plugin_on_track(trackId, tptr);
            this.mod._free(tptr);
            const numPlugins = this.mod._engine_get_num_plugins_on_track(trackId);
            this.port.postMessage({ type: 'plugin-added', trackId, rc, numPlugins });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `add-plugin threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'add-plugin: engine exports missing (stale wasm? — E2a build required)' });
        }
        break;
      case 'remove-plugin':
        if (this.mod && typeof this.mod._engine_remove_plugin_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const pluginIdx = msg.pluginIdx | 0;
          const rc = this.mod._engine_remove_plugin_on_track(trackId, pluginIdx);
          const numPlugins = this.mod._engine_get_num_plugins_on_track(trackId);
          // REFRESH AFTER A GRAPH-STRUCTURE EDIT (same class as
          // remove-aux-send: deleteFromParent frees the plugin while the
          // stale context still wires its node — the next play reuses the
          // dangling node. The native suite's refresh-after-edit discipline.)
          if (rc === 0 && typeof this.mod._engine_refresh_playback_graph === 'function') {
            this.mod._engine_refresh_playback_graph();
          }
          this.port.postMessage({ type: 'plugin-removed', trackId, pluginIdx, rc, numPlugins });
        } else {
          this.port.postMessage({ type: 'warn', message: 'remove-plugin: engine exports missing (stale wasm? — E2a build required)' });
        }
        break;
      case 'num-plugins':
        if (this.mod && typeof this.mod._engine_get_num_plugins_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          this.port.postMessage({ type: 'plugin-count', trackId,
            numPlugins: this.mod._engine_get_num_plugins_on_track(trackId) });
        } else {
          this.port.postMessage({ type: 'warn', message: 'num-plugins: engine exports missing (stale wasm? — E2a build required)' });
        }
        break;
      case 'plugin-type':
        if (this.mod && typeof this.mod._engine_get_plugin_type_on_track === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const pluginIdx = msg.pluginIdx | 0;
            const ptr = this.mod._engine_get_plugin_type_on_track(trackId, pluginIdx);
            const type = ptr ? this.mod.UTF8ToString(ptr) : '';
            // STATIC-BUFFER CONTRACT: never freed (the edit-xml discipline).
            this.port.postMessage({ type: 'plugin-type', trackId, pluginIdx, pluginType: type });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `plugin-type threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'plugin-type: engine exports missing (stale wasm? — E2a build required)' });
        }
        break;
      case 'move-plugin':
        if (this.mod && typeof this.mod._engine_move_plugin_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const fromIdx = msg.fromIdx | 0;
          const toIdx = msg.toIdx | 0;
          const rc = this.mod._engine_move_plugin_on_track(trackId, fromIdx, toIdx);
          const numPlugins = this.mod._engine_get_num_plugins_on_track(trackId);
          this.port.postMessage({ type: 'plugin-moved', trackId, fromIdx, toIdx, rc, numPlugins });
        } else {
          this.port.postMessage({ type: 'warn', message: 'move-plugin: engine exports missing (stale wasm? — E2a build required)' });
        }
        break;
      case 'set-plugin-bypass':
        if (this.mod && typeof this.mod._engine_set_plugin_bypass_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const pluginIdx = msg.pluginIdx | 0;
          const bypass = msg.bypass ? 1 : 0;
          const rc = this.mod._engine_set_plugin_bypass_on_track(trackId, pluginIdx, bypass);
          this.port.postMessage({ type: 'plugin-bypass-set', trackId, pluginIdx, bypass, rc });
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-plugin-bypass: engine exports missing (stale wasm? — E2a build required)' });
        }
        break;
      case 'plugin-params':
        // Discovery: the full paramId list of one effect (the gates' pinned
        // constants come from HERE; num bounds the readback loop).
        if (this.mod && typeof this.mod._engine_get_num_plugin_params === 'function'
            && typeof this.mod._engine_get_plugin_param_id === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const pluginIdx = msg.pluginIdx | 0;
            const numParams = this.mod._engine_get_num_plugin_params(trackId, pluginIdx);
            const paramIds = [];
            for (let i = 0; i < numParams; ++i) {
              const ptr = this.mod._engine_get_plugin_param_id(trackId, pluginIdx, i);
              paramIds.push(ptr ? this.mod.UTF8ToString(ptr) : '');
            }
            this.port.postMessage({ type: 'plugin-params', trackId, pluginIdx, numParams, paramIds });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `plugin-params threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'plugin-params: engine exports missing (stale wasm? — E2a build required)' });
        }
        break;
      case 'get-plugin-param':
        if (this.mod && typeof this.mod._engine_get_plugin_param_on_track === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const pluginIdx = msg.pluginIdx | 0;
            const idBytes = utf8BytesWorklet(String(msg.paramId || ''));
            const iptr = this.mod._malloc(idBytes.length + 1);
            if (!iptr) { this.port.postMessage({ type: 'warn', message: 'get-plugin-param: malloc failed' }); break; }
            this.mod.HEAPU8.set(idBytes, iptr);
            this.mod.HEAPU8[iptr + idBytes.length] = 0;
            const value = this.mod._engine_get_plugin_param_on_track(trackId, pluginIdx, iptr);
            this.mod._free(iptr);
            // NaN = paramId miss (the wrapper contract); JSON.stringify
            // turns NaN into null — the PAGE must null-check, not
            // truthiness-check.
            this.port.postMessage({ type: 'plugin-param', trackId, pluginIdx, paramId: String(msg.paramId || ''), value });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `get-plugin-param threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-plugin-param: engine exports missing (stale wasm? — E2a build required)' });
        }
        break;
      case 'set-plugin-param':
        // LIVE mid-play (D7). value coerced: NaN/undefined → REJECT
        // LOUDLY (§6a.13: NaN survives std::clamp/jlimit and poisons
        // filters) — never silently substitute a default.
        if (this.mod && typeof this.mod._engine_set_plugin_param_on_track === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const pluginIdx = msg.pluginIdx | 0;
            const value = Number(msg.value);
            if (!isFinite(value)) {
              this.port.postMessage({ type: 'warn', message: `set-plugin-param: non-finite value (${String(msg.value)}) rejected` });
              this.port.postMessage({ type: 'plugin-param-set', trackId, pluginIdx, paramId: String(msg.paramId || ''), rc: -5 });
              break;
            }
            const idBytes = utf8BytesWorklet(String(msg.paramId || ''));
            const iptr = this.mod._malloc(idBytes.length + 1);
            if (!iptr) { this.port.postMessage({ type: 'warn', message: 'set-plugin-param: malloc failed' }); break; }
            this.mod.HEAPU8.set(idBytes, iptr);
            this.mod.HEAPU8[iptr + idBytes.length] = 0;
            const rc = this.mod._engine_set_plugin_param_on_track(trackId, pluginIdx, iptr, value);
            this.mod._free(iptr);
            this.port.postMessage({ type: 'plugin-param-set', trackId, pluginIdx, paramId: String(msg.paramId || ''), rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `set-plugin-param threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-plugin-param: engine exports missing (stale wasm? — E2a build required)' });
        }
        break;
      case 'set-plugin-property':
        // The D4 escape hatch (Chorus/Phaser/Delay.length/LowPass.mode).
        // Same non-finite rejection as the param route.
        if (this.mod && typeof this.mod._engine_set_plugin_property_on_track === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const pluginIdx = msg.pluginIdx | 0;
            const value = Number(msg.value);
            if (!isFinite(value)) {
              this.port.postMessage({ type: 'warn', message: `set-plugin-property: non-finite value (${String(msg.value)}) rejected` });
              this.port.postMessage({ type: 'plugin-property-set', trackId, pluginIdx, prop: String(msg.prop || ''), rc: -5 });
              break;
            }
            const pBytes = utf8BytesWorklet(String(msg.prop || ''));
            const pptr = this.mod._malloc(pBytes.length + 1);
            if (!pptr) { this.port.postMessage({ type: 'warn', message: 'set-plugin-property: malloc failed' }); break; }
            this.mod.HEAPU8.set(pBytes, pptr);
            this.mod.HEAPU8[pptr + pBytes.length] = 0;
            const rc = this.mod._engine_set_plugin_property_on_track(trackId, pluginIdx, pptr, value);
            this.mod._free(pptr);
            this.port.postMessage({ type: 'plugin-property-set', trackId, pluginIdx, prop: String(msg.prop || ''), rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `set-plugin-property threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-plugin-property: engine exports missing (stale wasm? — E2a build required)' });
        }
        break;
      case 'get-plugin-property':
        if (this.mod && typeof this.mod._engine_get_plugin_property_on_track === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const pluginIdx = msg.pluginIdx | 0;
            const pBytes = utf8BytesWorklet(String(msg.prop || ''));
            const pptr = this.mod._malloc(pBytes.length + 1);
            if (!pptr) { this.port.postMessage({ type: 'warn', message: 'get-plugin-property: malloc failed' }); break; }
            this.mod.HEAPU8.set(pBytes, pptr);
            this.mod.HEAPU8[pptr + pBytes.length] = 0;
            const value = this.mod._engine_get_plugin_property_on_track(trackId, pluginIdx, pptr);
            this.mod._free(pptr);
            // NaN = unknown property (JSON → null; null-check on the page).
            this.port.postMessage({ type: 'plugin-property', trackId, pluginIdx, prop: String(msg.prop || ''), value });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `get-plugin-property threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-plugin-property: engine exports missing (stale wasm? — E2a build required)' });
        }
        break;
      // ==== Phase E2b: the mixer topology ====
      // Sends/buses/master-chain/meters. add/remove-send, add-bus and
      // add-master-plugin are PRE-PLAY (-4 while playing); the send gain/
      // mute and master params are LIVE mid-play; the meters are
      // READ-AND-CLEAR polls. Payload-field naming (§6e.2): pluginType /
      // busName — NEVER `type` (the duplicate-key discriminant shadow).
      case 'add-aux-send':
        if (this.mod && typeof this.mod._engine_add_aux_send_on_track === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const busNum = msg.busNum | 0;
            const gainDb = Number(msg.gainDb);
            if (!isFinite(gainDb)) {
              this.port.postMessage({ type: 'warn', message: `add-aux-send: non-finite gainDb (${String(msg.gainDb)}) rejected` });
              this.port.postMessage({ type: 'aux-send-added', trackId, busNum, rc: -5 });
              break;
            }
            const rc = this.mod._engine_add_aux_send_on_track(trackId, busNum, gainDb);
            const numSends = this.mod._engine_get_num_aux_sends_on_track(trackId);
            this.port.postMessage({ type: 'aux-send-added', trackId, busNum, gainDb, rc, numSends });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `add-aux-send threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'add-aux-send: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'remove-aux-send':
        if (this.mod && typeof this.mod._engine_remove_aux_send_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const sendIdx = msg.sendIdx | 0;
          const rc = this.mod._engine_remove_aux_send_on_track(trackId, sendIdx);
          const numSends = this.mod._engine_get_num_aux_sends_on_track(trackId);
          // REFRESH AFTER A GRAPH-STRUCTURE EDIT (the design's trap #4: the
          // sends join/leave the graph at BUILD — deleteFromParent frees the
          // plugin while the STALE playback context still wires its node →
          // the next play reuses the dangling node → SILENCE. The native
          // suite refreshes explicitly after every remove; the worklet must
          // too. rc==0 = a real removal happened.)
          if (rc === 0 && typeof this.mod._engine_refresh_playback_graph === 'function') {
            this.mod._engine_refresh_playback_graph();
          }
          this.port.postMessage({ type: 'aux-send-removed', trackId, sendIdx, rc, numSends });
        } else {
          this.port.postMessage({ type: 'warn', message: 'remove-aux-send: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'num-aux-sends':
        if (this.mod && typeof this.mod._engine_get_num_aux_sends_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          this.port.postMessage({ type: 'aux-send-count', trackId,
            numSends: this.mod._engine_get_num_aux_sends_on_track(trackId) });
        } else {
          this.port.postMessage({ type: 'warn', message: 'num-aux-sends: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'set-aux-send-gain':
        // LIVE mid-play. gainDb coerced: non-finite → REJECT LOUDLY.
        if (this.mod && typeof this.mod._engine_set_aux_send_gain_db === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const sendIdx = msg.sendIdx | 0;
            const gainDb = Number(msg.gainDb);
            if (!isFinite(gainDb)) {
              this.port.postMessage({ type: 'warn', message: `set-aux-send-gain: non-finite gainDb (${String(msg.gainDb)}) rejected` });
              this.port.postMessage({ type: 'aux-send-gain-set', trackId, sendIdx, rc: -5 });
              break;
            }
            const rc = this.mod._engine_set_aux_send_gain_db(trackId, sendIdx, gainDb);
            this.port.postMessage({ type: 'aux-send-gain-set', trackId, sendIdx, gainDb, rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `set-aux-send-gain threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-aux-send-gain: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'get-aux-send-gain':
        if (this.mod && typeof this.mod._engine_get_aux_send_gain_db === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const sendIdx = msg.sendIdx | 0;
          const gainDb = this.mod._engine_get_aux_send_gain_db(trackId, sendIdx);
          // -1000 = the bad track/idx sentinel (a legal dB, not NaN).
          this.port.postMessage({ type: 'aux-send-gain', trackId, sendIdx, gainDb });
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-aux-send-gain: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'set-aux-send-mute':
        if (this.mod && typeof this.mod._engine_set_aux_send_mute === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const sendIdx = msg.sendIdx | 0;
          const mute = msg.mute ? 1 : 0;
          const rc = this.mod._engine_set_aux_send_mute(trackId, sendIdx, mute);
          this.port.postMessage({ type: 'aux-send-mute-set', trackId, sendIdx, mute, rc });
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-aux-send-mute: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'add-aux-bus':
        if (this.mod && typeof this.mod._engine_add_aux_bus_track === 'function') {
          try {
            const busNum = msg.busNum | 0;
            const busName = String(msg.busName || '');
            const nBytes = utf8BytesWorklet(busName);
            const nptr = this.mod._malloc(nBytes.length + 1);
            if (!nptr) { this.port.postMessage({ type: 'warn', message: 'add-aux-bus: malloc failed' }); break; }
            this.mod.HEAPU8.set(nBytes, nptr);
            this.mod.HEAPU8[nptr + nBytes.length] = 0;
            const trackId = this.mod._engine_add_aux_bus_track(nptr, busNum);
            this.mod._free(nptr);
            const numTracks = this.mod._engine_get_num_tracks();
            // rc: the return IS the trackId on success; a negative return
            // is the error rc itself (the §6e.3 every-flow-gets-its-reply
            // discipline — the page's waitFor matches on rc).
            this.port.postMessage({ type: 'aux-bus-added', busNum, busName, trackId,
                                    numTracks, rc: trackId >= 0 ? 0 : trackId });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `add-aux-bus threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'add-aux-bus: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'ensure-aux-return':
        // E5: the idempotent return-ensure — the load-edit-xml re-apply
        // companion (the 2026-09-21 finding: the browser reload drops the
        // bus's auxreturn, and `auxreturn` is not E2a-addable while
        // add-aux-bus only creates NEW bus tracks). rc: 0 = ensured
        // (INCLUDING the already-present no-op — the demo's V13 re-apply
        // calls this every load) / -1 no engine / -2 bad trackId, busNum
        // outside [0,63], or the busNum claimed by ANOTHER track's return /
        // -3 creation failed / -4 transport playing (PRE-PLAY — stop
        // before re-applying post-reload).
        if (this.mod && typeof this.mod._engine_ensure_aux_return === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const busNum = msg.busNum | 0;
          const rc = this.mod._engine_ensure_aux_return(trackId, busNum);
          this.port.postMessage({ type: 'aux-return-ensured', trackId, busNum, rc });
        } else {
          this.port.postMessage({ type: 'warn', message: 'ensure-aux-return: engine exports missing (stale wasm? — E5 build required)' });
        }
        break;
      case 'set-aux-bus-name':
        if (this.mod && typeof this.mod._engine_set_aux_bus_name === 'function') {
          try {
            const busNum = msg.busNum | 0;
            const busName = String(msg.busName || '');
            const nBytes = utf8BytesWorklet(busName);
            const nptr = this.mod._malloc(nBytes.length + 1);
            if (!nptr) { this.port.postMessage({ type: 'warn', message: 'set-aux-bus-name: malloc failed' }); break; }
            this.mod.HEAPU8.set(nBytes, nptr);
            this.mod.HEAPU8[nptr + nBytes.length] = 0;
            const rc = this.mod._engine_set_aux_bus_name(busNum, nptr);
            this.mod._free(nptr);
            this.port.postMessage({ type: 'aux-bus-name-set', busNum, rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `set-aux-bus-name threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-aux-bus-name: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'get-aux-bus-name':
        if (this.mod && typeof this.mod._engine_get_aux_bus_name === 'function') {
          try {
            const busNum = msg.busNum | 0;
            const ptr = this.mod._engine_get_aux_bus_name(busNum);
            const busName = ptr ? this.mod.UTF8ToString(ptr) : '';
            // STATIC-BUFFER CONTRACT: never freed.
            this.port.postMessage({ type: 'aux-bus-name', busNum, busName });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `get-aux-bus-name threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-aux-bus-name: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'add-master-plugin':
        // The effect type rides `pluginType` (§6e.2 — NEVER `type`).
        if (this.mod && typeof this.mod._engine_add_plugin_on_master === 'function') {
          try {
            const typeBytes = utf8BytesWorklet(String(msg.pluginType || ''));
            const tptr = this.mod._malloc(typeBytes.length + 1);
            if (!tptr) { this.port.postMessage({ type: 'warn', message: 'add-master-plugin: malloc failed' }); break; }
            this.mod.HEAPU8.set(typeBytes, tptr);
            this.mod.HEAPU8[tptr + typeBytes.length] = 0;
            const rc = this.mod._engine_add_plugin_on_master(tptr);
            this.mod._free(tptr);
            const numPlugins = this.mod._engine_get_num_plugins_on_master();
            this.port.postMessage({ type: 'master-plugin-added', pluginType: String(msg.pluginType || ''), rc, numPlugins });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `add-master-plugin threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'add-master-plugin: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'num-master-plugins':
        if (this.mod && typeof this.mod._engine_get_num_plugins_on_master === 'function') {
          this.port.postMessage({ type: 'master-plugin-count',
            numPlugins: this.mod._engine_get_num_plugins_on_master() });
        } else {
          this.port.postMessage({ type: 'warn', message: 'num-master-plugins: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'set-master-param':
        // LIVE mid-play. value coerced: non-finite → REJECT LOUDLY.
        if (this.mod && typeof this.mod._engine_set_plugin_param_on_master === 'function') {
          try {
            const pluginIdx = msg.pluginIdx | 0;
            const value = Number(msg.value);
            if (!isFinite(value)) {
              this.port.postMessage({ type: 'warn', message: `set-master-param: non-finite value (${String(msg.value)}) rejected` });
              this.port.postMessage({ type: 'master-param-set', pluginIdx, paramId: String(msg.paramId || ''), rc: -5 });
              break;
            }
            const idBytes = utf8BytesWorklet(String(msg.paramId || ''));
            const iptr = this.mod._malloc(idBytes.length + 1);
            if (!iptr) { this.port.postMessage({ type: 'warn', message: 'set-master-param: malloc failed' }); break; }
            this.mod.HEAPU8.set(idBytes, iptr);
            this.mod.HEAPU8[iptr + idBytes.length] = 0;
            const rc = this.mod._engine_set_plugin_param_on_master(pluginIdx, iptr, value);
            this.mod._free(iptr);
            this.port.postMessage({ type: 'master-param-set', pluginIdx, paramId: String(msg.paramId || ''), rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `set-master-param threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-master-param: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'get-master-param':
        if (this.mod && typeof this.mod._engine_get_plugin_param_on_master === 'function') {
          try {
            const pluginIdx = msg.pluginIdx | 0;
            const idBytes = utf8BytesWorklet(String(msg.paramId || ''));
            const iptr = this.mod._malloc(idBytes.length + 1);
            if (!iptr) { this.port.postMessage({ type: 'warn', message: 'get-master-param: malloc failed' }); break; }
            this.mod.HEAPU8.set(idBytes, iptr);
            this.mod.HEAPU8[iptr + idBytes.length] = 0;
            const value = this.mod._engine_get_plugin_param_on_master(pluginIdx, iptr);
            this.mod._free(iptr);
            // NaN = paramId miss (JSON → null; null-check on the page).
            this.port.postMessage({ type: 'master-param', pluginIdx, paramId: String(msg.paramId || ''), value });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `get-master-param threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-master-param: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'get-track-level':
        // READ-AND-CLEAR: the value accumulates between polls (poll per
        // render block; sparse polling under-reads — the D7 contract).
        // -1000 = the no-meter/bad-track sentinel; -100 = a metered-
        // silent track (the DbTimePair floor).
        if (this.mod && typeof this.mod._engine_get_track_level_db === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const levelDb = this.mod._engine_get_track_level_db(trackId);
          this.port.postMessage({ type: 'track-level', trackId, levelDb });
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-track-level: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      case 'get-master-level':
        if (this.mod && typeof this.mod._engine_get_master_level_db === 'function') {
          const levelDb = this.mod._engine_get_master_level_db();
          // -1000 pre-play (no playback context — the R6 P2-7 contract).
          this.port.postMessage({ type: 'master-level', levelDb });
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-master-level: engine exports missing (stale wasm? — E2b build required)' });
        }
        break;
      // ==== Phase E2c: audio in the timeline (memory-buffer wave clips) ====
      // The 9 message cases (the debug route-probe has NO case — native
      // gates only). Payload fields NEVER named `type` (§6e.2). The PCM
      // payload rides the sfizz-register-sample malloc+HEAPF32 pattern
      // (planar [ch0][ch1]); the name cstr uses the nptr+bytes.length NUL
      // discipline (§6f.1 — the +ptr class). insert-wave-clip and
      // set-clip-fades REFRESH on rc===0 (the §6f.1 class — a stale
      // context wires dead clips; the E2b remove-fix pattern).
      case 'register-audio-buffer':
        // name + pcm (Float32Array, planar) + numFrames + numChannels +
        // sampleRate. rc: 0 / -1 / -2 (name) / -3 (shape) / -4 (playing) / -5.
        if (this.mod && typeof this.mod._engine_register_audio_buffer === 'function') {
          try {
            const name = String(msg.name || '');
            const data = msg.pcm;
            const frames = msg.numFrames | 0;
            const chans = Math.max(1, msg.numChannels | 0 || 1);
            if (!(data instanceof Float32Array) || data.length < frames * chans) {
              this.port.postMessage({ type: 'warn', message: 'register-audio-buffer: bad pcm payload' });
              break;
            }
            const bytes = frames * chans * 4;
            const ptr = this.mod._malloc(bytes);
            if (!ptr) {
              this.port.postMessage({ type: 'warn', message: 'register-audio-buffer: heap malloc failed' });
              break;
            }
            this.mod.HEAPF32.set(data.subarray(0, frames * chans), ptr >> 2);
            const nameBytes = utf8BytesWorklet(name);
            const nptr = this.mod._malloc(nameBytes.length + 1);
            if (!nptr) { this.mod._free(ptr); this.port.postMessage({ type: 'warn', message: 'register-audio-buffer: name malloc failed' }); break; }
            this.mod.HEAPU8.set(nameBytes, nptr);
            this.mod.HEAPU8[nptr + nameBytes.length] = 0;   // the +ptr NUL discipline
            const rate = Number(msg.sampleRate) || this.sampleRate;
            const rc = this.mod._engine_register_audio_buffer(nptr, ptr, frames, chans, rate);
            this.mod._free(nptr);
            this.mod._free(ptr);
            this.port.postMessage({ type: 'audio-buffer-registered', name, rc, numFrames: frames, numChannels: chans, sampleRate: rate });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `register-audio-buffer threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'register-audio-buffer: engine exports missing (stale wasm? — E2c build required)' });
        }
        break;
      case 'unregister-audio-buffer':
        if (this.mod && typeof this.mod._engine_unregister_audio_buffer === 'function') {
          try {
            const nameBytes = utf8BytesWorklet(String(msg.name || ''));
            const nptr = this.mod._malloc(nameBytes.length + 1);
            if (!nptr) { this.port.postMessage({ type: 'warn', message: 'unregister-audio-buffer: malloc failed' }); break; }
            this.mod.HEAPU8.set(nameBytes, nptr);
            this.mod.HEAPU8[nptr + nameBytes.length] = 0;
            const rc = this.mod._engine_unregister_audio_buffer(nptr);
            this.mod._free(nptr);
            this.port.postMessage({ type: 'audio-buffer-unregistered', name: String(msg.name || ''), rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `unregister-audio-buffer threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'unregister-audio-buffer: engine exports missing (stale wasm? — E2c build required)' });
        }
        break;
      case 'insert-wave-clip':
        // trackId + name + startSec + lengthSec. Returns clipIdx (>= 0) in
        // the reply. REFRESHES on rc===0 (structural — the §6f.1 class).
        if (this.mod && typeof this.mod._engine_insert_wave_clip_on_track === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const nameBytes = utf8BytesWorklet(String(msg.name || ''));
            const nptr = this.mod._malloc(nameBytes.length + 1);
            if (!nptr) { this.port.postMessage({ type: 'warn', message: 'insert-wave-clip: malloc failed' }); break; }
            this.mod.HEAPU8.set(nameBytes, nptr);
            this.mod.HEAPU8[nptr + nameBytes.length] = 0;
            const rc = this.mod._engine_insert_wave_clip_on_track(
              trackId, nptr, Number(msg.startSec) || 0, Number(msg.lengthSec) || 0);
            this.mod._free(nptr);
            this.port.postMessage({ type: 'wave-clip-inserted', trackId, name: String(msg.name || ''), startSec: Number(msg.startSec) || 0, lengthSec: Number(msg.lengthSec) || 0, clipIdx: rc, rc });
            if (rc === 0 || rc > 0) {
              // Structural edit: rebuild the playback context so the next
              // play sees the clip (rc>0 IS the success path — the clipIdx).
              if (typeof this.mod._engine_refresh_playback_graph === 'function')
                this.mod._engine_refresh_playback_graph();
            }
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `insert-wave-clip threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'insert-wave-clip: engine exports missing (stale wasm? — E2c build required)' });
        }
        break;
      case 'num-wave-clips':
        if (this.mod && typeof this.mod._engine_get_num_wave_clips_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const num = this.mod._engine_get_num_wave_clips_on_track(trackId);
          this.port.postMessage({ type: 'num-wave-clips', trackId, num });
        } else {
          this.port.postMessage({ type: 'warn', message: 'num-wave-clips: engine exports missing (stale wasm? — E2c build required)' });
        }
        break;
      case 'get-wave-clip-info':
        // The 13-field readback via the out-param buffer block. The name
        // rides a 64-byte heap scratch (the cstr read-back discipline).
        if (this.mod && typeof this.mod._engine_get_wave_clip_info === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const clipIdx = msg.clipIdx | 0 || 0;
            const NDBL = 10;                      // start, length, offset, gainDb, pan, fadeIn, fadeOut, srcRate, srcLengthSec + pad
            const dbl = this.mod._malloc(NDBL * 8);
            const i32 = this.mod._malloc(8);      // muted, srcChannels
            const i64 = this.mod._malloc(8);      // itemId
            const nameBuf = this.mod._malloc(64); // nameOut (names are <=63 validated)
            if (!dbl || !i32 || !i64 || !nameBuf) {
              if (dbl) this.mod._free(dbl);
              if (i32) this.mod._free(i32);
              if (i64) this.mod._free(i64);
              if (nameBuf) this.mod._free(nameBuf);
              this.port.postMessage({ type: 'warn', message: 'get-wave-clip-info: malloc failed' });
              break;
            }
            const rc = this.mod._engine_get_wave_clip_info(
              trackId, clipIdx,
              dbl, dbl + 8, dbl + 16, dbl + 24, dbl + 32, i32, dbl + 40, dbl + 48,
              dbl + 56, i32 + 4, dbl + 64, i64, nameBuf, 64);
            let info = null;
            if (rc === 0) {
              // getValue discipline (the get-clip-note precedent — HEAPF64/
              // HEAP32 are NOT in -sEXPORTED_RUNTIME_METHODS)
              let name = '';
              for (let i = 0; i < 63; i++) {
                const c = this.mod.HEAPU8[nameBuf + i];
                if (c === 0) break;
                name += String.fromCharCode(c);
              }
              info = {
                start: this.mod.getValue(dbl, 'double'),
                length: this.mod.getValue(dbl + 8, 'double'),
                offset: this.mod.getValue(dbl + 16, 'double'),
                gainDb: this.mod.getValue(dbl + 24, 'double'),
                pan: this.mod.getValue(dbl + 32, 'double'),
                muted: this.mod.getValue(i32, 'i32'),
                fadeIn: this.mod.getValue(dbl + 40, 'double'),
                fadeOut: this.mod.getValue(dbl + 48, 'double'),
                srcRate: this.mod.getValue(dbl + 56, 'double'),
                srcChannels: this.mod.getValue(i32 + 4, 'i32'),
                srcLengthSec: this.mod.getValue(dbl + 64, 'double'),
                itemId: this.mod.getValue(i64, 'i64'),
                name,
              };
            }
            this.mod._free(dbl); this.mod._free(i32); this.mod._free(i64); this.mod._free(nameBuf);
            this.port.postMessage({ type: 'wave-clip-info', trackId, clipIdx, rc, info });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `get-wave-clip-info threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-wave-clip-info: engine exports missing (stale wasm? — E2c build required)' });
        }
        break;
      case 'set-clip-gain':
        if (this.mod && typeof this.mod._engine_set_wave_clip_gain_db === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const clipIdx = msg.clipIdx | 0 || 0;
          const rc = this.mod._engine_set_wave_clip_gain_db(trackId, clipIdx, Number(msg.gainDb) || 0);
          this.port.postMessage({ type: 'clip-gain-set', trackId, clipIdx, gainDb: Number(msg.gainDb) || 0, rc });
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `set-clip-gain rc=${rc} (track ${trackId}, clip ${clipIdx})` });
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-clip-gain: engine exports missing (stale wasm? — E2c build required)' });
        }
        break;
      case 'set-clip-pan':
        if (this.mod && typeof this.mod._engine_set_wave_clip_pan === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const clipIdx = msg.clipIdx | 0 || 0;
          const rc = this.mod._engine_set_wave_clip_pan(trackId, clipIdx, Number(msg.pan) || 0);
          this.port.postMessage({ type: 'clip-pan-set', trackId, clipIdx, pan: Number(msg.pan) || 0, rc });
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `set-clip-pan rc=${rc} (track ${trackId}, clip ${clipIdx})` });
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-clip-pan: engine exports missing (stale wasm? — E2c build required)' });
        }
        break;
      case 'set-clip-mute':
        if (this.mod && typeof this.mod._engine_set_wave_clip_mute === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const clipIdx = msg.clipIdx | 0 || 0;
          const rc = this.mod._engine_set_wave_clip_mute(trackId, clipIdx, msg.muted ? 1 : 0);
          this.port.postMessage({ type: 'clip-mute-set', trackId, clipIdx, muted: msg.muted ? 1 : 0, rc });
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `set-clip-mute rc=${rc} (track ${trackId}, clip ${clipIdx})` });
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-clip-mute: engine exports missing (stale wasm? — E2c build required)' });
        }
        break;
      case 'set-clip-fades':
        // PRE-PLAY structural: REFRESHES on rc===0 (the fades are baked at
        // graph build — a set-while-stopped write needs the rebuild).
        if (this.mod && typeof this.mod._engine_set_wave_clip_fades === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const clipIdx = msg.clipIdx | 0 || 0;
          const rc = this.mod._engine_set_wave_clip_fades(
            trackId, clipIdx, Number(msg.fadeInSec) || 0, Number(msg.fadeOutSec) || 0);
          this.port.postMessage({ type: 'clip-fades-set', trackId, clipIdx, fadeInSec: Number(msg.fadeInSec) || 0, fadeOutSec: Number(msg.fadeOutSec) || 0, rc });
          if (rc === 0) {
            if (typeof this.mod._engine_refresh_playback_graph === 'function')
              this.mod._engine_refresh_playback_graph();
          } else {
            this.port.postMessage({ type: 'warn', message: `set-clip-fades rc=${rc} (track ${trackId}, clip ${clipIdx})` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-clip-fades: engine exports missing (stale wasm? — E2c build required)' });
        }
        break;
      // ==== Phase E2d: undo + clip editing + tempo (the 19 cases; the
      // design v2 §3.3 contract). The itemId args/returns are Numbers in
      // the messages (itemIds < 2^53) and BigInt at the wasm boundary (the
      // i64 params — the WebAssembly JS API rule); the per-case refresh
      // rule: delete/region/undo/redo/remove-tempo return 0 on success →
      // refresh on rc===0; move/set-length/split return the POSITIVE
      // itemId → refresh on rc>0 (the P0-2 class: a literal rc===0 check
      // would SKIP the rebuild); insert-tempo returns the positive index.
      case 'undo-begin':
        if (this.mod && typeof this.mod._engine_undo_begin === 'function') {
          try {
            const nameBytes = utf8BytesWorklet(String(msg.name || ''));
            const nptr = this.mod._malloc(nameBytes.length + 1);
            if (!nptr) { this.port.postMessage({ type: 'warn', message: 'undo-begin: malloc failed' }); break; }
            this.mod.HEAPU8.set(nameBytes, nptr);
            this.mod.HEAPU8[nptr + nameBytes.length] = 0;
            const rc = this.mod._engine_undo_begin(nptr);
            this.mod._free(nptr);
            this.port.postMessage({ type: 'undo-begun', name: String(msg.name || ''), rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `undo-begin threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'undo-begin: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'undo':
        // Structural: the wrapper already refreshes when stopped (the
        // deterministic post-undo graph — trap 2); the rc===0 belt+braces
        // refresh here composes (refresh is idempotent).
        if (this.mod && typeof this.mod._engine_undo === 'function') {
          const rc = this.mod._engine_undo();
          this.port.postMessage({ type: 'undo-done', rc });
          if (rc === 0) {
            if (typeof this.mod._engine_refresh_playback_graph === 'function')
              this.mod._engine_refresh_playback_graph();
          } else {
            this.port.postMessage({ type: 'warn', message: `undo rc=${rc} (-2 empty; -4 playing/recording)` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'undo: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'redo':
        if (this.mod && typeof this.mod._engine_redo === 'function') {
          const rc = this.mod._engine_redo();
          this.port.postMessage({ type: 'redo-done', rc });
          if (rc === 0) {
            if (typeof this.mod._engine_refresh_playback_graph === 'function')
              this.mod._engine_refresh_playback_graph();
          } else {
            this.port.postMessage({ type: 'warn', message: `redo rc=${rc}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'redo: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'can-undo':
        if (this.mod && typeof this.mod._engine_can_undo === 'function') {
          const v = this.mod._engine_can_undo();
          this.port.postMessage({ type: 'can-undo', value: v });
        } else {
          this.port.postMessage({ type: 'warn', message: 'can-undo: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'can-redo':
        if (this.mod && typeof this.mod._engine_can_redo === 'function') {
          const v = this.mod._engine_can_redo();
          this.port.postMessage({ type: 'can-redo', value: v });
        } else {
          this.port.postMessage({ type: 'warn', message: 'can-redo: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'get-num-undo':
        if (this.mod && typeof this.mod._engine_get_num_undo_transactions === 'function') {
          const num = this.mod._engine_get_num_undo_transactions();
          this.port.postMessage({ type: 'num-undo', num });
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-num-undo: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'get-undo-name':
        if (this.mod && typeof this.mod._engine_get_undo_name === 'function') {
          try {
            const index = msg.index | 0 || 0;
            const nameBuf = this.mod._malloc(64);
            if (!nameBuf) { this.port.postMessage({ type: 'warn', message: 'get-undo-name: malloc failed' }); break; }
            const rc = this.mod._engine_get_undo_name(index, nameBuf, 64);
            let name = '';
            if (rc === 0) {
              for (let i = 0; i < 63; i++) {
                const c = this.mod.HEAPU8[nameBuf + i];
                if (c === 0) break;
                name += String.fromCharCode(c);
              }
            }
            this.mod._free(nameBuf);
            this.port.postMessage({ type: 'undo-name', index, rc, name });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `get-undo-name threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-undo-name: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'get-num-redo':
        if (this.mod && typeof this.mod._engine_get_num_redo_transactions === 'function') {
          const num = this.mod._engine_get_num_redo_transactions();
          this.port.postMessage({ type: 'num-redo', num });
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-num-redo: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'get-redo-name':
        if (this.mod && typeof this.mod._engine_get_redo_name === 'function') {
          try {
            const index = msg.index | 0 || 0;
            const nameBuf = this.mod._malloc(64);
            if (!nameBuf) { this.port.postMessage({ type: 'warn', message: 'get-redo-name: malloc failed' }); break; }
            const rc = this.mod._engine_get_redo_name(index, nameBuf, 64);
            let name = '';
            if (rc === 0) {
              for (let i = 0; i < 63; i++) {
                const c = this.mod.HEAPU8[nameBuf + i];
                if (c === 0) break;
                name += String.fromCharCode(c);
              }
            }
            this.mod._free(nameBuf);
            this.port.postMessage({ type: 'redo-name', index, rc, name });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `get-redo-name threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-redo-name: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'move-clip':
        // PRE-PLAY structural (the node bakes position at build):
        // REFRESHES on rc>0 (rc IS the same itemId — the P0-2 rule).
        if (this.mod && typeof this.mod._engine_move_clip === 'function') {
          try {
            const itemId = toI64Worklet(msg.itemId);
            const rc = this.mod._engine_move_clip(itemId, Number(msg.newStartSec) || 0);
            const rcN = i64ToNumWorklet(rc);
            this.port.postMessage({ type: 'clip-moved', itemId: Number(msg.itemId) || 0, newStartSec: Number(msg.newStartSec) || 0, result: rcN });
            if (rcN > 0) {
              if (typeof this.mod._engine_refresh_playback_graph === 'function')
                this.mod._engine_refresh_playback_graph();
            } else {
              this.port.postMessage({ type: 'warn', message: `move-clip rc=${rcN} (-2 unknown; -3 range; -4 playing)` });
            }
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `move-clip threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'move-clip: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'set-clip-length':
        // PRE-PLAY structural: REFRESHES on rc>0 (the same itemId).
        if (this.mod && typeof this.mod._engine_set_clip_length === 'function') {
          try {
            const itemId = toI64Worklet(msg.itemId);
            const rc = this.mod._engine_set_clip_length(itemId, Number(msg.newLengthSec) || 0);
            const rcN = i64ToNumWorklet(rc);
            this.port.postMessage({ type: 'clip-length-set', itemId: Number(msg.itemId) || 0, newLengthSec: Number(msg.newLengthSec) || 0, result: rcN });
            if (rcN > 0) {
              if (typeof this.mod._engine_refresh_playback_graph === 'function')
                this.mod._engine_refresh_playback_graph();
            } else {
              this.port.postMessage({ type: 'warn', message: `set-clip-length rc=${rcN}` });
            }
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `set-clip-length threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-clip-length: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'split-clip':
        // PRE-PLAY structural: REFRESHES on rc>0 (rc IS the NEW clip's
        // itemId — the host re-enumerates after a split).
        if (this.mod && typeof this.mod._engine_split_clip === 'function') {
          try {
            const itemId = toI64Worklet(msg.itemId);
            const rc = this.mod._engine_split_clip(itemId, Number(msg.splitSec) || 0);
            const rcN = i64ToNumWorklet(rc);
            this.port.postMessage({ type: 'clip-split', itemId: Number(msg.itemId) || 0, splitSec: Number(msg.splitSec) || 0, newItemId: rcN });
            if (rcN > 0) {
              if (typeof this.mod._engine_refresh_playback_graph === 'function')
                this.mod._engine_refresh_playback_graph();
            } else {
              this.port.postMessage({ type: 'warn', message: `split-clip rc=${rcN} (-3 outside the 0.001s range)` });
            }
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `split-clip threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'split-clip: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'delete-clip':
        if (this.mod && typeof this.mod._engine_delete_clip === 'function') {
          try {
            const itemId = toI64Worklet(msg.itemId);
            const rc = this.mod._engine_delete_clip(itemId);
            const rcN = i64ToNumWorklet(rc);
            this.port.postMessage({ type: 'clip-deleted', itemId: Number(msg.itemId) || 0, result: rcN });
            if (rcN === 0) {
              if (typeof this.mod._engine_refresh_playback_graph === 'function')
                this.mod._engine_refresh_playback_graph();
            } else {
              this.port.postMessage({ type: 'warn', message: `delete-clip rc=${rcN}` });
            }
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `delete-clip threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'delete-clip: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'delete-clip-region':
        if (this.mod && typeof this.mod._engine_delete_clip_region === 'function') {
          try {
            const itemId = toI64Worklet(msg.itemId);
            const rc = this.mod._engine_delete_clip_region(itemId, Number(msg.startSec) || 0, Number(msg.endSec) || 0);
            const rcN = i64ToNumWorklet(rc);
            this.port.postMessage({ type: 'clip-region-deleted', itemId: Number(msg.itemId) || 0, startSec: Number(msg.startSec) || 0, endSec: Number(msg.endSec) || 0, result: rcN });
            if (rcN === 0) {
              if (typeof this.mod._engine_refresh_playback_graph === 'function')
                this.mod._engine_refresh_playback_graph();
            } else {
              this.port.postMessage({ type: 'warn', message: `delete-clip-region rc=${rcN} (-3 no-intersection/guard)` });
            }
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `delete-clip-region threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'delete-clip-region: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'insert-tempo-change':
        // REFRESHES on rc>0 (rc IS the new tempo's index).
        if (this.mod && typeof this.mod._engine_insert_tempo_change === 'function') {
          const rc = this.mod._engine_insert_tempo_change(Number(msg.atSec) || 0, Number(msg.bpm) || 0);
          this.port.postMessage({ type: 'tempo-change-inserted', atSec: Number(msg.atSec) || 0, bpm: Number(msg.bpm) || 0, index: rc });
          if (rc > 0) {
            if (typeof this.mod._engine_refresh_playback_graph === 'function')
              this.mod._engine_refresh_playback_graph();
          } else {
            this.port.postMessage({ type: 'warn', message: `insert-tempo-change rc=${rc} (-3 bpm outside [20,300])` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'insert-tempo-change: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'remove-tempo':
        if (this.mod && typeof this.mod._engine_remove_tempo === 'function') {
          const index = msg.index | 0 || 0;
          const rc = this.mod._engine_remove_tempo(index);
          this.port.postMessage({ type: 'tempo-removed', index, rc });
          if (rc === 0) {
            if (typeof this.mod._engine_refresh_playback_graph === 'function')
              this.mod._engine_refresh_playback_graph();
          } else {
            this.port.postMessage({ type: 'warn', message: `remove-tempo rc=${rc} (-3 index 0 protected)` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'remove-tempo: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'get-num-tempos':
        if (this.mod && typeof this.mod._engine_get_num_tempos === 'function') {
          const num = this.mod._engine_get_num_tempos();
          this.port.postMessage({ type: 'num-tempos', num });
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-num-tempos: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'get-tempo-info':
        if (this.mod && typeof this.mod._engine_get_tempo_info === 'function') {
          try {
            const index = msg.index | 0 || 0;
            const dbl = this.mod._malloc(16);
            if (!dbl) { this.port.postMessage({ type: 'warn', message: 'get-tempo-info: malloc failed' }); break; }
            const rc = this.mod._engine_get_tempo_info(index, dbl, dbl + 8);
            let info = null;
            if (rc === 0) {
              info = {
                startBeat: this.mod.getValue(dbl, 'double'),
                bpm: this.mod.getValue(dbl + 8, 'double'),
              };
            }
            this.mod._free(dbl);
            this.port.postMessage({ type: 'tempo-info', index, rc, info });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `get-tempo-info threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-tempo-info: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      case 'get-transport-events':
        if (this.mod && typeof this.mod._engine_debug_get_transport_events === 'function') {
          const count = this.mod._engine_debug_get_transport_events();
          this.port.postMessage({ type: 'transport-events', count });
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-transport-events: engine exports missing (stale wasm? — E2d build required)' });
        }
        break;
      // ==== Phase 11: recording (engine-native) ====
      // arm-track needs a destination to exist: send AFTER select-input-track
      // + enable-live-input. Arm changes are refused while capturing (-4).
      // record-start retries are CAPPED (the stopped branch can burn ~300ms
      // of worklet-thread stall each attempt) and gate on the CAPTURING
      // signal, never the transport flag (a phantom recording flags true
      // with zero contexts — rc -4 unsticks it; stop retrying then).
      // ==== Phase E2e: automation + folders + moveTo + the counters (23
      // cases; PHASE-E2E-AUTOMATION-FOLDERS.md v2 §4). The refresh rules
      // (the R1 P0-3 table): insert-folder + move-clip-to-track refresh on
      // rc>0 (int64 itemIds >= 1); add-track-in-folder on rc>=0 (a flat
      // trackId — 0 IS valid); move-track-to-folder on rc===0 (returns 0);
      // the 10 curve writes + the folder fader/mute are LIVE — NO refresh
      // (a refresh resets the smoothed gains — the E2b discipline).
      case 'automation-get-num-points': {
        const fn = this.mod && this.mod._engine_automation_get_num_points;
        if (fn) {
          try {
            const pid = cstrW(this.mod, String(msg.paramId || ''));
            if (!pid) break;
            const count = fn(msg.trackId | 0, msg.pluginIdx | 0, pid);
            freeW(this.mod, pid);
            this.port.postMessage({ type: 'automation-num-points', trackId: msg.trackId | 0, pluginIdx: msg.pluginIdx | 0, paramId: String(msg.paramId || ''), count });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `automation-get-num-points threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'automation-get-num-points: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'automation-get-point': {
        const fn = this.mod && this.mod._engine_automation_get_point;
        if (fn) {
          try {
            const pid = cstrW(this.mod, String(msg.paramId || ''));
            if (!pid) break;
            const dbl = this.mod._malloc(8);
            const fv = this.mod._malloc(4);
            const fc = this.mod._malloc(4);
            if (!dbl || !fv || !fc) { if (dbl) this.mod._free(dbl); if (fv) this.mod._free(fv); if (fc) this.mod._free(fc); freeW(this.mod, pid); this.port.postMessage({ type: 'warn', message: 'automation-get-point: malloc failed' }); break; }
            const rc = fn(msg.trackId | 0, msg.pluginIdx | 0, pid, msg.pointIdx | 0, dbl, fv, fc);
            const t = this.mod.getValue(dbl, 'double');
            const v = this.mod.getValue(fv, 'float');
            const cu = this.mod.getValue(fc, 'float');
            if (dbl) this.mod._free(dbl); if (fv) this.mod._free(fv); if (fc) this.mod._free(fc);
            freeW(this.mod, pid);
            this.port.postMessage({ type: 'automation-point', trackId: msg.trackId | 0, pluginIdx: msg.pluginIdx | 0, paramId: String(msg.paramId || ''), pointIdx: msg.pointIdx | 0, rc, t, v, c: cu });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `automation-get-point threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'automation-get-point: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'automation-add-point': {
        // LIVE (no refresh — the curve applies on the pumps, D3).
        const fn = this.mod && this.mod._engine_automation_add_point;
        if (fn) {
          try {
            const pid = cstrW(this.mod, String(msg.paramId || ''));
            if (!pid) break;
            const index = fn(msg.trackId | 0, msg.pluginIdx | 0, pid, Number(msg.t) || 0, Number(msg.v) || 0, Number(msg.c) || 0);
            freeW(this.mod, pid);
            this.port.postMessage({ type: 'automation-point-added', trackId: msg.trackId | 0, pluginIdx: msg.pluginIdx | 0, paramId: String(msg.paramId || ''), index });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `automation-add-point threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'automation-add-point: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'automation-remove-point': {
        const fn = this.mod && this.mod._engine_automation_remove_point;
        if (fn) {
          try {
            const pid = cstrW(this.mod, String(msg.paramId || ''));
            if (!pid) break;
            const rc = fn(msg.trackId | 0, msg.pluginIdx | 0, pid, msg.pointIdx | 0);
            freeW(this.mod, pid);
            this.port.postMessage({ type: 'automation-point-removed', trackId: msg.trackId | 0, pluginIdx: msg.pluginIdx | 0, paramId: String(msg.paramId || ''), pointIdx: msg.pointIdx | 0, rc });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `automation-remove-point threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'automation-remove-point: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'automation-set-point-value': {
        const fn = this.mod && this.mod._engine_automation_set_point_value;
        if (fn) {
          try {
            const pid = cstrW(this.mod, String(msg.paramId || ''));
            if (!pid) break;
            const rc = fn(msg.trackId | 0, msg.pluginIdx | 0, pid, msg.pointIdx | 0, Number(msg.v) || 0);
            freeW(this.mod, pid);
            this.port.postMessage({ type: 'automation-point-value-set', trackId: msg.trackId | 0, pluginIdx: msg.pluginIdx | 0, paramId: String(msg.paramId || ''), pointIdx: msg.pointIdx | 0, rc });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `automation-set-point-value threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'automation-set-point-value: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'automation-set-point-curve': {
        const fn = this.mod && this.mod._engine_automation_set_point_curve;
        if (fn) {
          try {
            const pid = cstrW(this.mod, String(msg.paramId || ''));
            if (!pid) break;
            const rc = fn(msg.trackId | 0, msg.pluginIdx | 0, pid, msg.pointIdx | 0, Number(msg.c) || 0);
            freeW(this.mod, pid);
            this.port.postMessage({ type: 'automation-point-curve-set', trackId: msg.trackId | 0, pluginIdx: msg.pluginIdx | 0, paramId: String(msg.paramId || ''), pointIdx: msg.pointIdx | 0, rc });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `automation-set-point-curve threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'automation-set-point-curve: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'automation-clear': {
        const fn = this.mod && this.mod._engine_automation_clear;
        if (fn) {
          try {
            const pid = cstrW(this.mod, String(msg.paramId || ''));
            if (!pid) break;
            const rc = fn(msg.trackId | 0, msg.pluginIdx | 0, pid);
            freeW(this.mod, pid);
            this.port.postMessage({ type: 'automation-cleared', trackId: msg.trackId | 0, pluginIdx: msg.pluginIdx | 0, paramId: String(msg.paramId || ''), rc });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `automation-clear threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'automation-clear: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'automation-set-bypass': {
        const fn = this.mod && this.mod._engine_automation_set_bypass;
        if (fn) {
          try {
            const pid = cstrW(this.mod, String(msg.paramId || ''));
            if (!pid) break;
            const rc = fn(msg.trackId | 0, msg.pluginIdx | 0, pid, (msg.bypass ? 1 : 0));
            freeW(this.mod, pid);
            this.port.postMessage({ type: 'automation-bypass-set', trackId: msg.trackId | 0, pluginIdx: msg.pluginIdx | 0, paramId: String(msg.paramId || ''), bypass: msg.bypass ? 1 : 0, rc });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `automation-set-bypass threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'automation-set-bypass: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'automation-get-bypass': {
        const fn = this.mod && this.mod._engine_automation_get_bypass;
        if (fn) {
          try {
            const pid = cstrW(this.mod, String(msg.paramId || ''));
            if (!pid) break;
            const value = fn(msg.trackId | 0, msg.pluginIdx | 0, pid);
            freeW(this.mod, pid);
            this.port.postMessage({ type: 'automation-bypass', trackId: msg.trackId | 0, pluginIdx: msg.pluginIdx | 0, paramId: String(msg.paramId || ''), value });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `automation-get-bypass threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'automation-get-bypass: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'automation-get-param-range': {
        const fn = this.mod && this.mod._engine_automation_get_param_range;
        if (fn) {
          try {
            const pid = cstrW(this.mod, String(msg.paramId || ''));
            if (!pid) break;
            const fmn = this.mod._malloc(4);
            const fmx = this.mod._malloc(4);
            if (!fmn || !fmx) { if (fmn) this.mod._free(fmn); if (fmx) this.mod._free(fmx); freeW(this.mod, pid); this.port.postMessage({ type: 'warn', message: 'automation-get-param-range: malloc failed' }); break; }
            const rc = fn(msg.trackId | 0, msg.pluginIdx | 0, pid, fmn, fmx);
            const mn = this.mod.getValue(fmn, 'float');
            const mx = this.mod.getValue(fmx, 'float');
            if (fmn) this.mod._free(fmn); if (fmx) this.mod._free(fmx);
            freeW(this.mod, pid);
            this.port.postMessage({ type: 'automation-param-range', trackId: msg.trackId | 0, pluginIdx: msg.pluginIdx | 0, paramId: String(msg.paramId || ''), rc, min: mn, max: mx });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `automation-get-param-range threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'automation-get-param-range: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'insert-folder': {
        // Topology: REFRESH on rc>0 (the int64 itemId >= 1).
        const fn = this.mod && this.mod._engine_insert_folder_track;
        if (fn) {
          try {
            const nptr = cstrW(this.mod, String(msg.name || ''));
            if (!nptr) break;
            const rc = fn(nptr, toI64Worklet(msg.parentFolderId || 0));
            freeW(this.mod, nptr);
            const rcN = i64ToNumWorklet(rc);
            this.port.postMessage({ type: 'folder-inserted', name: String(msg.name || ''), folderId: rcN });
            if (rcN > 0) if (this.mod && typeof this.mod._engine_refresh_playback_graph === 'function') this.mod._engine_refresh_playback_graph();
            else this.port.postMessage({ type: 'warn', message: `insert-folder rc=${rcN}` });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `insert-folder threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'insert-folder: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'add-track-in-folder': {
        // Topology: REFRESH on rc>=0 (a flat trackId — 0 IS a valid success).
        const fn = this.mod && this.mod._engine_add_track_in_folder;
        if (fn) {
          try {
            const nptr = cstrW(this.mod, String(msg.name || ''));
            if (!nptr) break;
            const trackId = fn(toI64Worklet(msg.folderId || 0), nptr);
            freeW(this.mod, nptr);
            this.port.postMessage({ type: 'track-added-in-folder', name: String(msg.name || ''), folderId: Number(msg.folderId) || 0, trackId });
            if (trackId >= 0) if (this.mod && typeof this.mod._engine_refresh_playback_graph === 'function') this.mod._engine_refresh_playback_graph();
            else this.port.postMessage({ type: 'warn', message: `add-track-in-folder rc=${trackId}` });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `add-track-in-folder threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'add-track-in-folder: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'move-track-to-folder': {
        // Topology: REFRESH on rc===0 (returns 0 on success — NOT a positive id).
        const fn = this.mod && this.mod._engine_move_track_to_folder;
        if (fn) {
          try {
            const rc = fn(toI64Worklet(msg.trackItemId || 0), toI64Worklet(msg.folderId || 0));
            this.port.postMessage({ type: 'track-moved-to-folder', trackItemId: Number(msg.trackItemId) || 0, folderId: Number(msg.folderId) || 0, rc });
            if (rc === 0) if (this.mod && typeof this.mod._engine_refresh_playback_graph === 'function') this.mod._engine_refresh_playback_graph();
            else this.port.postMessage({ type: 'warn', message: `move-track-to-folder rc=${rc}` });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `move-track-to-folder threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'move-track-to-folder: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'get-track-item-id': {
        const fn = this.mod && this.mod._engine_get_track_item_id;
        if (fn) {
          try {
            const id = fn(msg.trackId | 0);
            this.port.postMessage({ type: 'track-item-id', trackId: msg.trackId | 0, itemId: i64ToNumWorklet(id) });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `get-track-item-id threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'get-track-item-id: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'get-num-folder-tracks': {
        const fn = this.mod && this.mod._engine_get_num_folder_tracks;
        if (fn) {
          try {
            const count = fn();
            this.port.postMessage({ type: 'num-folder-tracks', count });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `get-num-folder-tracks threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'get-num-folder-tracks: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'get-folder-track-id': {
        const fn = this.mod && this.mod._engine_get_folder_track_id;
        if (fn) {
          try {
            const id = fn(msg.folderIdx | 0);
            this.port.postMessage({ type: 'folder-track-id', folderIdx: msg.folderIdx | 0, folderId: i64ToNumWorklet(id) });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `get-folder-track-id threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'get-folder-track-id: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'get-track-parent-folder': {
        const fn = this.mod && this.mod._engine_get_track_parent_folder_id;
        if (fn) {
          try {
            const id = fn(msg.trackId | 0);
            this.port.postMessage({ type: 'track-parent-folder', trackId: msg.trackId | 0, folderId: i64ToNumWorklet(id) });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `get-track-parent-folder threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'get-track-parent-folder: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'set-folder-volume-db': {
        // LIVE (the fader param — NO refresh; a refresh resets the
        // smoothed gains, the E2b discipline).
        const fn = this.mod && this.mod._engine_set_folder_volume_db;
        if (fn) {
          try {
            const rc = fn(toI64Worklet(msg.folderId || 0), Number(msg.db) || 0);
            this.port.postMessage({ type: 'folder-volume-set', folderId: Number(msg.folderId) || 0, db: Number(msg.db) || 0, rc });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `set-folder-volume-db threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'set-folder-volume-db: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'set-folder-mute': {
        // LIVE (the TrackMutingNode applies per block — NO refresh).
        const fn = this.mod && this.mod._engine_set_folder_mute;
        if (fn) {
          try {
            const rc = fn(toI64Worklet(msg.folderId || 0), (msg.mute ? 1 : 0));
            this.port.postMessage({ type: 'folder-mute-set', folderId: Number(msg.folderId) || 0, mute: msg.mute ? 1 : 0, rc });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `set-folder-mute threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'set-folder-mute: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'move-clip-to-track': {
        // Topology: REFRESH on rc>0 (rc IS the UNCHANGED itemId).
        const fn = this.mod && this.mod._engine_move_clip_to_track;
        if (fn) {
          try {
            const rc = fn(toI64Worklet(msg.itemId || 0), msg.targetTrackId | 0);
            const rcN = i64ToNumWorklet(rc);
            this.port.postMessage({ type: 'clip-moved-to-track', itemId: Number(msg.itemId) || 0, targetTrackId: msg.targetTrackId | 0, result: rcN });
            if (rcN > 0) if (this.mod && typeof this.mod._engine_refresh_playback_graph === 'function') this.mod._engine_refresh_playback_graph();
            else this.port.postMessage({ type: 'warn', message: `move-clip-to-track rc=${rcN} (-1 bad target; -2 unknown; -3 same/type/frozen; -4 playing)` });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `move-clip-to-track threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'move-clip-to-track: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'get-graph-rebuild-count': {
        const fn = this.mod && this.mod._engine_debug_get_graph_rebuild_count;
        if (fn) {
          try {
            this.port.postMessage({ type: 'graph-rebuild-count', count: fn() });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `get-graph-rebuild-count threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'get-graph-rebuild-count: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'get-rebuild-request-count': {
        const fn = this.mod && this.mod._engine_debug_get_rebuild_request_count;
        if (fn) {
          try {
            this.port.postMessage({ type: 'rebuild-request-count', count: fn() });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `get-rebuild-request-count threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'get-rebuild-request-count: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'reset-rebuild-counters': {
        const fn = this.mod && this.mod._engine_debug_reset_rebuild_counters;
        if (fn) {
          try {
            fn();
            this.port.postMessage({ type: 'rebuild-counters-reset' });
          } catch (e) { this.port.postMessage({ type: 'warn', message: `reset-rebuild-counters threw: ${String(e)}` }); }
        } else this.port.postMessage({ type: 'warn', message: 'reset-rebuild-counters: engine exports missing (stale wasm? — E2e build required)' });
        break;
      }
      case 'arm-track':
        if (this.mod && typeof this.mod._engine_set_input_track_armed === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const armed = msg.armed ? 1 : 0;
          const rc = this.mod._engine_set_input_track_armed(trackId, armed);
          this.port.postMessage({ type: 'armed-status', trackId, armed, rc });
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `arm-track rc=${rc} (track ${trackId}, armed ${armed})` });
        } else {
          this.port.postMessage({ type: 'warn', message: 'arm-track: engine exports missing (stale wasm?)' });
        }
        break;
      case 'has-armed':
        // Armed-state readback (tests + the rebuild re-apply contract). The
        // raw rc is forwarded so a -1 (bad id / no destination) reads as an
        // ERROR, not a silent "disarmed" (3-lens review).
        if (this.mod && typeof this.mod._engine_get_input_track_armed === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const rc = this.mod._engine_get_input_track_armed(trackId);
          this.port.postMessage({ type: 'armed-status', trackId, armed: rc === 1, rc });
        } else {
          this.port.postMessage({ type: 'warn', message: 'has-armed: engine exports missing (stale wasm?)' });
        }
        break;
      case 'record-start': {
        if (this.mod && typeof this.mod._engine_record_start === 'function') {
          const allow = msg.allowIfNotArmed ? 1 : 0;
          let rc = -3;
          try {
            rc = this.mod._engine_record_start(allow);
            // Retry only while the retry is meaningful: not capturing AND no
            // phantom (-4) AND attempts remain. Capturing is the REAL signal.
            for (let i = 0; i < 2 && rc !== 0 && rc !== -4 && rc !== -2; i++) {
              if (typeof this.mod._engine_pump_message_loop === 'function') {
                try { this.mod._engine_pump_message_loop(); } catch (_) {}
              }
              rc = this.mod._engine_record_start(allow);
            }
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `record-start threw: ${String(e)}` });
            break;
          }
          const capturing = (typeof this.mod._engine_is_capturing === 'function')
            ? this.mod._engine_is_capturing() : 0;
          const recording = (typeof this.mod._engine_is_recording === 'function')
            ? this.mod._engine_is_recording() : 0;
          this.port.postMessage({ type: 'record-status', recording, capturing, rc });
          if (rc !== 0) this.port.postMessage({ type: 'warn', message: `record-start rc=${rc} (capturing ${capturing})` });
        } else {
          this.port.postMessage({ type: 'warn', message: 'record-start: engine exports missing (stale wasm?)' });
        }
        break;
      }
      case 'record-stop': {
        if (this.mod && typeof this.mod._engine_record_stop === 'function') {
          const discard = msg.discard ? 1 : 0;
          // Capture BEFORE the call: the C++ refreshes only when it
          // finalized a REAL capture (wasCapturing && !discard) — the reply
          // must not report a refresh for a phantom stop (3-lens review).
          const wasCapturing = (typeof this.mod._engine_is_capturing === 'function')
            ? this.mod._engine_is_capturing() : 0;
          let rc = -2;
          try { rc = this.mod._engine_record_stop(discard); } catch (e) {
            this.port.postMessage({ type: 'warn', message: `record-stop threw: ${String(e)}` });
            break;
          }
          const capturing = (typeof this.mod._engine_is_capturing === 'function')
            ? this.mod._engine_is_capturing() : 0;
          const recording = (typeof this.mod._engine_is_recording === 'function')
            ? this.mod._engine_is_recording() : 0;
          this.port.postMessage({ type: 'record-status', recording, capturing, rc, refreshed: rc === 0 && !discard && !!wasCapturing });
        } else {
          this.port.postMessage({ type: 'warn', message: 'record-stop: engine exports missing (stale wasm?)' });
        }
        break;
      }
      case 'is-recording':
        if (this.mod && typeof this.mod._engine_is_recording === 'function'
            && typeof this.mod._engine_is_capturing === 'function') {
          this.port.postMessage({
            type: 'recording-status',
            recording: this.mod._engine_is_recording(),
            capturing: this.mod._engine_is_capturing(),
          });
        } else {
          this.port.postMessage({ type: 'warn', message: 'is-recording: engine exports missing (stale wasm?)' });
        }
        break;
      case 'get-clip-count':
        if (this.mod && typeof this.mod._engine_get_num_midi_clips_on_track === 'function') {
          const trackId = msg.trackId | 0 || 0;
          this.port.postMessage({ type: 'clip-count', trackId, count: this.mod._engine_get_num_midi_clips_on_track(trackId) });
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-clip-count: engine exports missing (stale wasm?)' });
        }
        break;
      case 'get-num-notes':
        // Bounded readback for pages (the 3-lens review: a blind probe cap
        // silently truncates and the page-model re-apply then makes it data
        // loss — pages must loop against the REAL count).
        if (this.mod && typeof this.mod._engine_get_num_midi_notes_in_clip === 'function') {
          const trackId = msg.trackId | 0 || 0;
          this.port.postMessage({ type: 'num-notes', trackId, clipIdx: msg.clipIdx | 0, count: this.mod._engine_get_num_midi_notes_in_clip(trackId, msg.clipIdx | 0) });
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-num-notes: engine exports missing (stale wasm?)' });
        }
        break;
      case 'get-clip-note':
        // Readback via getValue: HEAPF64/HEAP32 are NOT in
        // -sEXPORTED_RUNTIME_METHODS (only HEAPF32/HEAPU8/HEAP8 + getValue/
        // setValue) — this.mod.HEAPF64 is undefined in the modularized build
        // and the failure would be BROWSER-ONLY (Node calls the export
        // directly). The design doc pins this.
        if (this.mod && typeof this.mod._engine_get_midi_note_in_clip === 'function'
            && typeof this.mod.getValue === 'function') {
          const trackId = msg.trackId | 0 || 0;
          const clipIdx = msg.clipIdx | 0;
          const noteIdx = msg.noteIdx | 0;
          const ptr = this.mod._malloc(24); // 2 doubles + 2 ints, 8-aligned
          if (!ptr) {
            this.port.postMessage({ type: 'warn', message: 'get-clip-note: malloc failed' });
            break;
          }
          try {
            const rc = this.mod._engine_get_midi_note_in_clip(
              trackId, clipIdx, noteIdx, ptr, ptr + 8, ptr + 16, ptr + 20);
            if (rc === 0) {
              this.port.postMessage({
                type: 'clip-note', trackId, clipIdx, noteIdx, found: true,
                startBeat: this.mod.getValue(ptr, 'double'),
                lengthBeats: this.mod.getValue(ptr + 8, 'double'),
                pitch: this.mod.getValue(ptr + 16, 'i32'),
                velocity: this.mod.getValue(ptr + 20, 'i32'),
              });
            } else {
              this.port.postMessage({ type: 'clip-note', trackId, clipIdx, noteIdx, found: false, rc });
            }
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `get-clip-note threw: ${String(e)}` });
          } finally {
            this.mod._free(ptr);
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-clip-note: engine exports missing (stale wasm?)' });
        }
        break;
      case 'rebuild-engine':
        // Phase 8: full engine re-instantiation from the cached binary (the
        // reset path — see the _wasmBinary note in the constructor). The
        // page re-applies its state (bpm, clip, notes, sounds) AFTER the
        // new 'ready' message arrives; messages sent during the rebuild are
        // dropped (wasmReady is false until re-init completes).
        if (!this._rebuilding && this._wasmBinary) {
          this._rebuildEngine();
        } else {
          this.port.postMessage({ type: 'warn', message: 'rebuild-engine ignored: no cached binary or already rebuilding' });
        }
        break;
      case 'debug-set':
        // Intentional diagnostic surface (kept after CodeRabbit review): the
        // browser liveness test pings this to detect event-loop starvation /
        // deadlocks, and it is how the three browser-silence root causes were
        // isolated. Only the owning page can reach this port; the globals it
        // sets are read by nothing in the audio path.
        globalThis[msg.key] = msg.value;
        this.port.postMessage({ type: 'warn', message: `debug-set ${msg.key}=${JSON.stringify(msg.value)}` });
        break;
      case 'probe-clock':
        // Intentional diagnostic (kept after CodeRabbit review): verifies
        // whether performance.now() is a real wall clock or frozen audio
        // time — THE check that identified root cause #2 (frozen-clock
        // nanosleep deadlock). Never sent in normal operation; busy-waits
        // ~50ms on the worklet thread when explicitly invoked.
        {
          const t0 = (globalThis.performance && globalThis.performance.now) ? globalThis.performance.now() : null;
          const d0 = Date.now();
          // busy-wait ~50ms of real time
          while (Date.now() - d0 < 50) {}
          const t1 = (globalThis.performance && globalThis.performance.now) ? globalThis.performance.now() : null;
          this.port.postMessage({
            type: 'warn',
            message: `probe-clock: perfType=${typeof globalThis.performance} perfNowType=${typeof (globalThis.performance && globalThis.performance.now)} t0=${t0} t1=${t1} delta=${(t1 !== null && t0 !== null) ? (t1 - t0) : 'n/a'} (expect ~50 if real clock, ~0 if frozen audio time)`,
          });
        }
        break;
      case 'pump':
        // Periodic pump driven by the PAGE (between render quanta — safe).
        // Keeps deferred engine work (transport position updates etc.)
        // flowing during playback; see CodeRabbit R8[0] discussion.
        if (this.mod && typeof this.mod._engine_pump_message_loop === 'function') {
          try { this.mod._engine_pump_message_loop(); } catch (_) {}
        }
        break;
      case 'dump-status':
        if (this.mod && typeof this.mod._engine_debug_status === 'function') {
          try {
            this.port.postMessage({ type: 'warn', message: 'status: ' + this.mod.UTF8ToString(this.mod._engine_debug_status()).slice(0, 700) });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: 'dump-status threw: ' + String(e) });
          }
        }
        break;
      // ==== Phase 12: persistence ====
      case 'get-edit-xml':
        if (this.mod && typeof this.mod._engine_get_edit_state_xml === 'function') {
          try {
            const ptr = this.mod._engine_get_edit_state_xml();
            const xml = ptr ? this.mod.UTF8ToString(ptr) : '';
            if (!xml) {
              // Silent-skip discipline (§6a.9): an empty state means no
              // engine/edit — surface it, the page must not assume success.
              this.port.postMessage({ type: 'warn', message: 'get-edit-xml: empty state (no engine?)' });
            }
            this.port.postMessage({ type: 'edit-xml', xml });
            // STATIC-BUFFER CONTRACT: ptr is a static std::string buffer —
            // NEVER freed; the next call overwrites it (single-threaded
            // worklet: safe).
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: 'get-edit-xml threw: ' + String(e) });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-edit-xml: engine exports missing (stale wasm?)' });
        }
        break;
      case 'load-edit-xml':
        if (typeof msg.xml === 'string' && msg.xml.length > 0) {
          if (!this._rebuilding && this._wasmBinary && this.wasmReady) {
            // The full load = the rebuild sequence with the state plumbed
            // through _initOpts: 'ready' {fromState:true} arrives first,
            // then 'edit-loaded' {rc, numTracks}. The page re-applies its
            // sound model + live input gated on 'edit-loaded'.
            this._initOpts.initialEditXml = msg.xml;
            this._pendingEditLoaded = true;
            this._rebuildEngine();
          } else if (!this.wasmReady) {
            // Engine never inited — the page-load flow uses init-wasm's
            // initialEditXml option instead (that is the fresh-page path).
            this.port.postMessage({ type: 'warn', message: 'load-edit-xml: engine not ready — use init-wasm {initialEditXml}' });
          } else {
            this.port.postMessage({ type: 'warn', message: 'load-edit-xml ignored: no cached binary or already rebuilding' });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'load-edit-xml: no xml string' });
        }
        break;
      // ==================================================================
      // The E3 bounce/export surface (PHASE-E3-BOUNCE-EXPORT.md §5). The
      // bounce BLOCKS the worklet thread ~0.5-1 s (the 188-block pre-count
      // sleeps + the render — the E1 freewheeling precedent) — the page
      // must be STOPPED (the -4 guard enforces it).
      // ==================================================================
      case 'bounce-render': {
        // path + startSec + endSec + blockSize + useMasterPlugins +
        // endAllowanceMs. rc: 0 / -1 / -2 (args) / -3 (task) / -4 (playing)
        // / -5 (the file missing/short). MEMFS path on wasm.
        if (this.mod && typeof this.mod._engine_bounce_render === 'function') {
          try {
            const path = String(msg.path || '');
            const start = Number(msg.startSec), end = Number(msg.endSec);
            const block = msg.blockSize | 0, master = msg.useMasterPlugins | 0;
            const allowMs = msg.endAllowanceMs | 0;
            const pb = utf8BytesWorklet(path);
            const pptr = this.mod._malloc(pb.length + 1);
            if (!pptr) { this.port.postMessage({ type: 'warn', message: 'bounce-render: path malloc failed' }); break; }
            this.mod.HEAPU8.set(pb, pptr);
            this.mod.HEAPU8[pptr + pb.length] = 0;
            const rc = this.mod._engine_bounce_render(pptr, start, end, block, master, allowMs);
            this.mod._free(pptr);
            this.port.postMessage({ type: 'bounce-rendered', path, rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: 'bounce-render threw: ' + String(e) });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'bounce-render: engine exports missing (stale wasm? — E3 build required)' });
        }
        break;
      }
      case 'bounce-stats': {
        // The last bounce's task->params stats (out-params marshalled).
        if (this.mod && typeof this.mod._engine_bounce_get_stats === 'function') {
          try {
            const rms = this.mod._malloc(8), peak = this.mod._malloc(8);
            const dur = this.mod._malloc(8), fr = this.mod._malloc(8);
            if (!rms || !peak || !dur || !fr) {
              this.port.postMessage({ type: 'warn', message: 'bounce-stats: malloc failed' });
              [rms, peak, dur, fr].forEach((p) => p && this.mod._free(p));
              break;
            }
            const rc = this.mod._engine_bounce_get_stats(rms, peak, dur, fr);
            const stats = {
              rc,
              rms: this.mod.getValue(rms, 'double'),
              peak: this.mod.getValue(peak, 'double'),
              durationSec: this.mod.getValue(dur, 'double'),
              frames: Number(this.mod.getValue(fr, 'i64')),   // BigInt -> Number (§6h.5)
            };
            [rms, peak, dur, fr].forEach((p) => this.mod._free(p));
            this.port.postMessage({ type: 'bounce-stats', ...stats });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: 'bounce-stats threw: ' + String(e) });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'bounce-stats: engine exports missing' });
        }
        break;
      }
      case 'bounce-file-size': {
        if (this.mod && typeof this.mod._engine_bounce_get_file_size === 'function') {
          try {
            const path = String(msg.path || '');
            const pb = utf8BytesWorklet(path);
            const pptr = this.mod._malloc(pb.length + 1);
            this.mod.HEAPU8.set(pb, pptr);
            this.mod.HEAPU8[pptr + pb.length] = 0;
            const sizeBig = this.mod._engine_bounce_get_file_size(pptr);
            this.mod._free(pptr);
            const size = Number(sizeBig);                     // i64 -> BigInt -> Number
            this.port.postMessage({ type: 'bounce-file-size', path, size });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: 'bounce-file-size threw: ' + String(e) });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'bounce-file-size: engine exports missing' });
        }
        break;
      }
      case 'bounce-read-file': {
        // The BYTES out — a TRANSFERRED ArrayBuffer reply (a NEW reply
        // pattern: every prior reply is a plain object — the collector +
        // waitFor matchers must handle it, §6e.9). Query the size FIRST.
        if (this.mod && typeof this.mod._engine_bounce_read_file === 'function'
            && typeof this.mod._engine_bounce_get_file_size === 'function') {
          try {
            const path = String(msg.path || '');
            const pb = utf8BytesWorklet(path);
            const pptr = this.mod._malloc(pb.length + 1);
            this.mod.HEAPU8.set(pb, pptr);
            this.mod.HEAPU8[pptr + pb.length] = 0;
            const sizeBig = this.mod._engine_bounce_get_file_size(pptr);
            const size = Number(sizeBig);
            if (size <= 0) {
              this.mod._free(pptr);
              this.port.postMessage({ type: 'bounce-read-file', path, rc: -2, size: 0, bytes: null });
              break;
            }
            const buf = this.mod._malloc(size);
            if (!buf) {
              this.mod._free(pptr);
              this.port.postMessage({ type: 'warn', message: 'bounce-read-file: heap malloc failed (' + size + 'B)' });
              break;
            }
            const got = this.mod._engine_bounce_read_file(pptr, buf, size);
            this.mod._free(pptr);
            if (got !== size) {
              this.mod._free(buf);
              this.port.postMessage({ type: 'bounce-read-file', path, rc: got < 0 ? got : -1, size, bytes: null });
              break;
            }
            // copy out of the wasm heap BEFORE any re-init (the MEMFS
            // durability contract — §7.7): a fresh Uint8Array (a copy),
            // transferred.
            const out = new Uint8Array(size);
            out.set(this.mod.HEAPU8.subarray(buf, buf + size));
            this.mod._free(buf);
            this.port.postMessage({ type: 'bounce-read-file', path, rc: 0, size, bytes: out.buffer }, [out.buffer]);
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: 'bounce-read-file threw: ' + String(e) });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'bounce-read-file: engine exports missing' });
        }
        break;
      }
      case 'get-block-drop-count': {
        if (this.mod && typeof this.mod._engine_debug_get_block_drop_count === 'function') {
          this.port.postMessage({ type: 'block-drop-count', count: this.mod._engine_debug_get_block_drop_count() });
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-block-drop-count: engine exports missing' });
        }
        break;
      }
      case 'get-render-drop-count': {
        if (this.mod && typeof this.mod._engine_debug_get_render_drop_count === 'function') {
          this.port.postMessage({ type: 'render-drop-count', count: this.mod._engine_debug_get_render_drop_count() });
        } else {
          this.port.postMessage({ type: 'warn', message: 'get-render-drop-count: engine exports missing' });
        }
        break;
      }
      case 'reset-drop-counters': {
        if (this.mod && typeof this.mod._engine_debug_reset_block_drop_counters === 'function') {
          this.mod._engine_debug_reset_block_drop_counters();
          this.port.postMessage({ type: 'drop-counters-reset' });
        } else {
          this.port.postMessage({ type: 'warn', message: 'reset-drop-counters: engine exports missing' });
        }
        break;
      }
      // ==== Phase E4 browser legs (the V2-demo surface): pitch / speed /
      // IR / analysis — the deferred E4 browser work, on the REAL worklet
      // path. All three mutations are PRE-PLAY (-4 while playing) and
      // REFRESH on rc===0 (the R1-P0-3 fold: the stretcher/IR selection
      // happens at GRAPH BUILD, not in the reader — every native/twin gate
      // refreshes after these writes; a surviving playback context would
      // otherwise keep the stale reader and the write would be inaudible).
      case 'set-wave-clip-pitch': {
        // trackId + clipIdx + semitones. rc: 0 / -1 bad track / -2 bad
        // index / -3 out of [-48,48] / -4 playing / -5 non-finite.
        if (this.mod && typeof this.mod._engine_set_wave_clip_pitch === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const clipIdx = msg.clipIdx | 0 || 0;
            const semitones = Number(msg.semitones);
            const rc = this.mod._engine_set_wave_clip_pitch(trackId, clipIdx, semitones);
            if (rc === 0 && typeof this.mod._engine_refresh_playback_graph === 'function') {
              this.mod._engine_refresh_playback_graph();
            }
            this.port.postMessage({ type: 'wave-clip-pitch-set', trackId, clipIdx, semitones, rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `set-wave-clip-pitch threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-wave-clip-pitch: engine exports missing (stale wasm? — E4 build required)' });
        }
        break;
      }
      case 'set-wave-clip-speed': {
        // trackId + clipIdx + ratio. TRUE VARISPEED (content = sourceLen/r,
        // pitch = f0*r) — the clip's edit LENGTH is a pure CachedValue and
        // does NOT move: the PAGE owns the r<1 window fix (speed ->
        // set-clip-length{itemId, sourceLen/r} -> refresh; the native
        // family's window-fixed leg). rc: 0 / -1 / -2 / -3 ratio<=0 / -4
        // playing / -5 non-finite.
        if (this.mod && typeof this.mod._engine_set_wave_clip_speed === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const clipIdx = msg.clipIdx | 0 || 0;
            const ratio = Number(msg.ratio);
            const rc = this.mod._engine_set_wave_clip_speed(trackId, clipIdx, ratio);
            if (rc === 0 && typeof this.mod._engine_refresh_playback_graph === 'function') {
              this.mod._engine_refresh_playback_graph();
            }
            this.port.postMessage({ type: 'wave-clip-speed-set', trackId, clipIdx, ratio, rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `set-wave-clip-speed threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'set-wave-clip-speed: engine exports missing (stale wasm? — E4 build required)' });
        }
        break;
      }
      case 'ir-load-data': {
        // trackId + pluginIdx + bytes (an ArrayBuffer holding a WAV file
        // image — Uint8/HEAPU8, NOT float). The page TRANSFERS the buffer
        // (single-use). rc: 0 / -1 bad track / -2 bad index / -3 not an IR
        // plugin / -4 playing / -5 null bytes / -6 the load failed
        // (decode). Structural: refresh on rc===0 (the plugin node
        // rebuilds — cpp:3071-3073).
        if (this.mod && typeof this.mod._engine_ir_load_data === 'function') {
          try {
            const trackId = msg.trackId | 0 || 0;
            const pluginIdx = msg.pluginIdx | 0 || 0;
            const bytes = msg.bytes;
            if (!(bytes instanceof ArrayBuffer) || bytes.byteLength <= 0) {
              this.port.postMessage({ type: 'ir-loaded', trackId, pluginIdx, rc: -5 });
              break;
            }
            const size = bytes.byteLength;
            const ptr = this.mod._malloc(size);
            if (!ptr) {
              this.port.postMessage({ type: 'warn', message: 'ir-load-data: heap malloc failed (' + size + 'B)' });
              break;
            }
            this.mod.HEAPU8.set(new Uint8Array(bytes), ptr);
            const rc = this.mod._engine_ir_load_data(trackId, pluginIdx, ptr, size);
            this.mod._free(ptr);
            if (rc === 0 && typeof this.mod._engine_refresh_playback_graph === 'function') {
              this.mod._engine_refresh_playback_graph();
            }
            this.port.postMessage({ type: 'ir-loaded', trackId, pluginIdx, rc });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `ir-load-data threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'ir-load-data: engine exports missing (stale wasm? — E4 build required)' });
        }
        break;
      }
      case 'analyse-audio-file': {
        // path (native real path / wasm MEMFS — an E3 bounce or an
        // FS.writeFile'd asset). The reply's json is the STATIC-BUFFER
        // string (UTF8ToString, NEVER freed — the edit-xml contract).
        // SLOW: the 65,536-frame block loop takes seconds on wasm; it runs
        // here in handleMessage (between quanta) so the audio GLITCHES for
        // the duration — the page gates this on stopped transport + warns.
        // Success = the full JSON object; failure = {"error": "..."}.
        if (this.mod && typeof this.mod._engine_analyse_audio_file === 'function') {
          try {
            const path = String(msg.path || '');
            const pb = utf8BytesWorklet(path);
            const pptr = this.mod._malloc(pb.length + 1);
            if (!pptr) { this.port.postMessage({ type: 'warn', message: 'analyse-audio-file: path malloc failed' }); break; }
            this.mod.HEAPU8.set(pb, pptr);
            this.mod.HEAPU8[pptr + pb.length] = 0;
            const jsonPtr = this.mod._engine_analyse_audio_file(pptr);
            this.mod._free(pptr);
            const json = jsonPtr ? this.mod.UTF8ToString(jsonPtr) : '';
            this.port.postMessage({ type: 'audio-analysed', path, json });
          } catch (e) {
            this.port.postMessage({ type: 'warn', message: `analyse-audio-file threw: ${String(e)}` });
          }
        } else {
          this.port.postMessage({ type: 'warn', message: 'analyse-audio-file: engine exports missing (stale wasm? — E4d build required)' });
        }
        break;
      }
    }
  }

  process(inputs, outputs) {
    try {
    // Drain polyfilled timers at every render quantum (macrotask boundary —
    // see the timer polyfill note at the top of this file). The callbacks
    // are the emscripten main-loop no-op (and anything else that scheduled
    // a JS timeout); they must run for the worklet event loop to stay alive.
    if (typeof globalThis.__drainWorkletTimers === 'function') {
      globalThis.__drainWorkletTimers();
    }

    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const numChannels = Math.min(output.length, this.numChannels);
    const blockSize = output[0].length;
    if (blockSize === 0) return true;
    this.processCount++;

    // ---- Primary path: real tracktion engine audio ----
    if (this.engineMode && this.mod && this.outPtr && blockSize <= this.maxBlockSize) {
      this.mod._engine_process_block(this.outPtr, blockSize);
      const heap = this.mod.HEAPF32;
      const off = this.outPtr >> 2;
      let sumSq = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const dst = output[ch];
        const src = heap.subarray(off + ch * blockSize, off + (ch + 1) * blockSize);
        for (let i = 0; i < blockSize; i++) {
          const s = src[i];
          dst[i] = s;
          sumSq += s * s;
        }
      }
      const rms = Math.sqrt(sumSq / (blockSize * numChannels));
      if (rms > 0.0005) this.engineAudioBlocks++;

      this.reportPosition(rms, true);
      return true;
    }

    // ---- Fallback: JS sine-wave synthesis (pre-Phase 6 behaviour) ----
    for (let i = 0; i < blockSize; i++) {
      let sample = 0;

      if (this.liveNote !== null && this.liveNoteFrame < this.liveNoteDuration) {
        const freq = midiToFreq(this.liveNote);
        const t = this.liveNoteFrame / this.sampleRate;
        const env = Math.exp(-t * 3);
        sample = Math.sin(2 * Math.PI * freq * t) * 0.3 * env;
        this.liveNoteFrame++;
      } else if (this.isPlaying) {
        const beatDur = 60 / this.bpm;
        const secPerFrame = 1 / this.sampleRate;
        const elapsed = this.melodyFrame * secPerFrame;
        if (elapsed >= this.totalMelodySec) {
          this.isPlaying = false;
        } else {
          let noteStart = 0;
          for (const note of MELODY) {
            const noteDur = note.beats * beatDur;
            if (elapsed < noteStart + noteDur) {
              const t = this.melodyFrame / this.sampleRate;
              const noteElapsed = elapsed - noteStart;
              const env = Math.min(1, noteElapsed / 0.005) * Math.min(1, (noteDur - noteElapsed) / 0.005);
              sample = Math.sin(2 * Math.PI * midiToFreq(note.midi) * t) * 0.25 * env;
              break;
            }
            noteStart += noteDur;
          }
          this.melodyFrame++;
        }
      }

      for (let ch = 0; ch < numChannels; ch++) {
        output[ch][i] = sample;
      }
    }

    this.reportPosition(0, false);
    return true;
    } catch (e) {
      // A throw inside process() would REMOVE this node from the audio graph
      // (spec behaviour) → permanent silence with no diagnostic. Surface the
      // error to the page ONCE and keep the node alive instead.
      if (!this._processErrorReported) {
        this._processErrorReported = true;
        try {
          this.port.postMessage({ type: 'error', error: `process() threw (block #${this.processCount}): ${String((e && e.stack) || e)}` });
        } catch (_) {}
      }
      return true;
    }
  }

  reportPosition(rms, fromEngine) {
    if (this.processCount % 50 !== 0) return;
    let pos = 0, playing = 0;
    if (this.mod) {
      try {
        pos = this.mod._engine_transport_get_position();
        playing = this.mod._engine_transport_is_playing();
      } catch (e) {}
    }
    const effectivePlaying = playing || (this.isPlaying ? 1 : 0);
    this.port.postMessage({
      type: 'position',
      position: pos,
      isPlaying: effectivePlaying,
      rms,
      engineAudio: fromEngine,
      engineAudioBlocks: this.engineAudioBlocks,
      processCount: this.processCount,
      wallClock: Date.now(),
    });
  }
}

registerProcessor('phase5-processor', Phase5Processor);
