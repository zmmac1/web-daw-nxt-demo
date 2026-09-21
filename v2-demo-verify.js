// ═══════════════════════════════════════════════════════════════════════
// v2-demo-verify.js — the V2 measured verification suite (V1..V14)
// spec §8: every audible test parks the transport first (stop → 300 ms →
// seek → 200 ms → play → 600 ms settle — §6.13), band energies are
// Goertzel taps with non-harmonic neighbours (≥25 % separation), mutating
// tests restore + re-verify, and every row prints its measured values.
//
// Loaded by v2-demo.js (which owns the protocol layer + the UI rows).
// ═══════════════════════════════════════════════════════════════════════

export function createVerifySuite(ctx) {
  const { post, waitFor, postW, state, sleep } = ctx;
  const C = ctx.constants;
  const dbToLin = (db) => Math.pow(10, db / 20);

  // the parked play, returning the wall-clock anchor of the transport-play
  // post (content-end measurements convert wall → transport time with it)
  async function playFrom(sec) {
    post({ type: 'transport-stop' });
    await sleep(300);
    post({ type: 'seek', seconds: Number(sec) || 0 });
    await sleep(200);
    const tPlay = performance.now();
    post({ type: 'transport-play' });
    await sleep(600);
    return tPlay;
  }

  // band pair: [measured, neighbour] mean dB over `ms`
  async function bandPair(f, n, ms) {
    const [a, b] = await Promise.all([ctx.meanBandDb(f, ms), ctx.meanBandDb(n, ms)]);
    return { a, b, delta: a - b };
  }

  // the dominant frequency (median of k sweeps) in [lo, hi]
  async function dominant(lo, hi, k = 5) {
    const xs = [];
    for (let i = 0; i < k; i++) { xs.push(ctx.dominantFreq(lo, hi)); await sleep(50); }
    xs.sort((x, y) => x - y);
    return xs[Math.floor(xs.length / 2)];
  }

  // the content end (transport seconds): the last sample whose band energy
  // stays within `dropDb` of the steady maximum (the E4e pair discriminator)
  async function contentEnd(tPlay, freq, fromT, toT, dropDb = 12) {
    const pts = [];
    for (let t = fromT; t <= toT; t += 0.045) {
      const wait = tPlay + t * 1000 - performance.now();
      if (wait > 0) await sleep(wait);
      pts.push({ t, db: ctx.bandDb(freq) });
    }
    let steady = -Infinity;
    for (const p of pts.slice(0, 5)) steady = Math.max(steady, p.db);
    let ce = null;
    for (const p of pts) if (p.db >= steady - dropDb) ce = p.t;
    return { ce, steady, n: pts.length };
  }

  const gates = {
    // the chord f0s (bar 1 = Em) vs non-harmonic neighbours
    keysBands: [[164.8, 205], [246.9, 300], [329.6, 400]],
  };

  // ─── the tests ────────────────────────────────────────────────────────
  const TESTS = {

    V1: {
      name: 'Engine + arrangement introspection',
      method: 'track/plugin/clip/sfizz counts + types vs the build baseline (the FILTERED plugin space — the seeded 4osc is invisible; sfizz state via the sfizz-* cases)',
      run: async () => {
        if (!state.baseline) throw new Error('build the arrangement first');
        const exp = state.baseline;
        const got = {};
        const mismatches = [];
        const eq = (label, a, b) => {
          if (a !== b) mismatches.push(label + ': ' + a + ' != ' + b);
        };
        const nt = await postW({ type: 'num-tracks' }, 'track-count', null, 8000);
        got.numTracks = nt ? nt.numTracks : null;
        eq('numTracks', got.numTracks, exp.numTracks + (state.testSine ? 1 : 0));
        const nf = await postW({ type: 'get-num-folder-tracks' }, 'num-folder-tracks', null, 8000);
        eq('folders', nf ? nf.count : null, exp.folders);
        for (const tid of [1, 2]) {
          const pf = await postW({ type: 'get-track-parent-folder', trackId: tid },
            'track-parent-folder', (m) => m.trackId === tid, 8000);
          eq('parent(' + tid + ')', pf ? Number(pf.folderId) : null, state.folder.id);
        }
        const wc = await postW({ type: 'num-wave-clips', trackId: 0 }, 'num-wave-clips',
          (m) => m.trackId === 0, 8000);
        eq('waveClips(0)', wc ? wc.num : null, exp.waveClips0);
        for (const tid of [1, 2]) {
          const cc = await postW({ type: 'get-clip-count', trackId: tid }, 'clip-count',
            (m) => m.trackId === tid, 8000);
          eq('midiClips(' + tid + ')', cc ? cc.count : null, exp.midiClips[tid]);
          const nn = await postW({ type: 'get-num-notes', trackId: tid, clipIdx: 0 }, 'num-notes',
            (m) => m.trackId === tid, 8000);
          eq('notes(' + tid + ')', nn ? nn.count : null, exp.notes[tid]);
        }
        const p0 = await postW({ type: 'num-plugins', trackId: 0 }, 'plugin-count',
          (m) => m.trackId === 0, 8000);
        eq('plugins(0) [filtered]', p0 ? p0.numPlugins : null, 0);
        const p1 = await postW({ type: 'num-plugins', trackId: 1 }, 'plugin-count',
          (m) => m.trackId === 1, 8000);
        eq('plugins(1)', p1 ? p1.numPlugins : null, exp.plugins[1]);
        const t1 = await postW({ type: 'plugin-type', trackId: 1, pluginIdx: 0 }, 'plugin-type',
          (m) => m.trackId === 1, 8000);
        eq('pluginType(1,0)', t1 ? t1.pluginType : null, '4bandEq');
        const pb = await postW({ type: 'num-plugins', trackId: state.busTrackId }, 'plugin-count',
          (m) => m.trackId === state.busTrackId, 8000);
        eq('plugins(bus)', pb ? pb.numPlugins : null, exp.plugins.bus);
        const tb = await postW({ type: 'plugin-type', trackId: state.busTrackId, pluginIdx: 0 },
          'plugin-type', (m) => m.trackId === state.busTrackId, 8000);
        eq('pluginType(bus,0)', tb ? tb.pluginType : null, 'impulseResponse');
        const mp = await postW({ type: 'num-master-plugins' }, 'master-plugin-count', null, 8000);
        eq('masterPlugins', mp ? mp.numPlugins : null, exp.master);
        for (const tid of [1, 2]) {
          const s = await postW({ type: 'num-aux-sends', trackId: tid }, 'aux-send-count',
            (m) => m.trackId === tid, 8000);
          eq('sends(' + tid + ')', s ? s.numSends : null, exp.sends[tid]);
          const rg = await postW({ type: 'sfizz-num-regions', trackId: tid }, 'sfizz-region-count',
            (m) => m.trackId === tid, 8000);
          eq('sfizzRegions(' + tid + ')', rg ? rg.numRegions : null, exp.regions[tid]);
        }
        const cp = await postW({ type: 'automation-get-num-points', trackId: C.CURVE.trackId,
          pluginIdx: C.CURVE.pluginIdx, paramId: C.CURVE.paramId }, 'automation-num-points', null, 8000);
        eq('curvePoints', cp ? cp.count : null, exp.curvePoints);
        const measured = 'tracks ' + got.numTracks + ' · folders ' + (nf && nf.count)
          + ' · waveClips(0) ' + (wc && wc.num) + ' · plugins(1) ' + (p1 && p1.numPlugins)
          + ' = ' + (t1 && t1.pluginType) + ' · bus ' + (tb && tb.pluginType)
          + ' · master ' + (mp && mp.numPlugins) + ' · regions ' + (exp.regions[1]) + '/'
          + (exp.regions[2]) + ' · curve ' + (cp && cp.count) + ' pts';
        return { pass: mismatches.length === 0, measured: mismatches.length
          ? ('MISMATCH: ' + mismatches.join(' | ')) : measured };
      },
    },

    V2: {
      name: 'sfizz chord renders (E1)',
      method: 'parked-play bar 1 (Em: E3/B3/E4) · Goertzel band vs non-harmonic neighbour',
      run: async () => {
        await ctx.stopTransport();
        await playFrom(0);
        await sleep(150);
        const res = [];
        for (const [f, n] of gates.keysBands) res.push(await bandPair(f, n, 800));
        await ctx.stopTransport();
        const worst = Math.min(...res.map((r) => r.delta));
        return { pass: res.every((r) => r.delta >= 6.0),
          measured: res.map((r, i) => 'f' + [164.8, 246.9, 329.6][i] + ': '
            + r.delta.toFixed(1) + ' dB over nb').join(' · ') + ' (worst ' + worst.toFixed(1) + ')' };
      },
    },

    V3: {
      name: 'Live keyboard → sfizz (E2e live input)',
      method: 'transport stopped · note-on E4 held ~1 s · band 329.6 vs 400 Hz',
      run: async () => {
        await ctx.stopTransport();
        post({ type: 'select-input-track', trackId: 1 });
        await sleep(200);
        const li = await postW({ type: 'enable-live-input' }, 'live-input-enabled', null, 8000);
        await sleep(150);
        ctx.pianoNoteOn(64, 100);
        await sleep(300);
        const r = await bandPair(329.6, 400, 650);
        await sleep(100);
        ctx.pianoNoteOff(64);
        return { pass: !!li && r.delta >= 6.0,
          measured: 'live-input rc=' + (li ? li.rc : 'null') + ' · E4 band '
            + r.delta.toFixed(1) + ' dB over neighbour' };
      },
    },

    V4: {
      name: 'Mixer: track volume LIVE (E2b)',
      method: 'Keys −20 dB mid-play · E3 band vs a drums-only 6 kHz reference (the decay-normalized form)',
      run: async () => {
        await ctx.stopTransport();
        await playFrom(0);
        const pre = await bandPair(164.8, 6000, 350);
        post({ type: 'set-track-volume', trackId: 1, gain: dbToLin(-20) });
        await sleep(380);
        const postB = await bandPair(164.8, 6000, 350);
        post({ type: 'set-track-volume', trackId: 1, gain: 1.0 });
        await sleep(200);
        await ctx.stopTransport();
        const deltaDb = (postB.a - postB.b) - (pre.a - pre.b);
        const ratio = dbToLin(deltaDb);
        return { pass: ratio >= 0.06 && ratio <= 0.16,
          measured: 'normalized Δ ' + deltaDb.toFixed(1) + ' dB → ratio ' + ratio.toFixed(3)
            + ' (window 0.06–0.16)' };
      },
    },

    V5: {
      name: 'Mute/unmute CLEAN (the E2f fix)',
      method: 'pre-mute vs post-unmute E3 band, fresh parked renders + one absorber render after the unmute (§6j.5)',
      run: async () => {
        await ctx.stopTransport();
        await playFrom(0);
        const a = await ctx.meanBandDb(164.8, 700);
        await ctx.stopTransport();
        post({ type: 'set-track-mute', trackId: 1, mute: true });
        await sleep(250);
        await playFrom(0);
        const muted = await ctx.meanBandDb(164.8, 450);
        await ctx.stopTransport();
        post({ type: 'set-track-mute', trackId: 1, mute: false });
        await sleep(250);
        await playFrom(0);            // the absorber render (discarded)
        await ctx.stopTransport();
        await playFrom(0);
        const b = await ctx.meanBandDb(164.8, 700);
        await ctx.stopTransport();
        const ratio = dbToLin(b - a);
        return { pass: ratio >= 0.85 && ratio <= 1.15 && (a - muted) >= 12,
          measured: 'pre ' + a.toFixed(1) + ' dB · muted ' + muted.toFixed(1)
            + ' dB (' + (a - muted).toFixed(1) + ' down) · post-unmute ' + b.toFixed(1)
            + ' dB → ratio ' + ratio.toFixed(3) + ' (window 0.85–1.15)' };
      },
    },

    V6: {
      name: 'Master EQ mid-cut toggle (E2a, LIVE)',
      method: 'cut −18 dB @ ' + C.MASTER_CUT_HZ + ' Hz mid-play · B3 band vs the 6 kHz reference, pre/post at matched decay',
      run: async () => {
        await ctx.stopTransport();
        await playFrom(0);
        const pre = await bandPair(C.MASTER_CUT_HZ, 6000, 350);
        const on = await postW({ type: 'set-master-param', pluginIdx: 0,
          paramId: 'Mid gain 1', value: -18.0 }, 'master-param-set',
          (m) => m.paramId === 'Mid gain 1', 6000);
        await sleep(380);
        const postB = await bandPair(C.MASTER_CUT_HZ, 6000, 350);
        post({ type: 'set-master-param', pluginIdx: 0, paramId: 'Mid gain 1', value: 0.0 });
        await sleep(200);
        await ctx.stopTransport();
        const dip = (pre.a - pre.b) - (postB.a - postB.b);
        return { pass: !!on && on.rc === 0 && dip >= 8.0,
          measured: 'normalized dip ' + dip.toFixed(1) + ' dB (≥ 8) · param rc=' + (on && on.rc) };
      },
    },

    V7: {
      name: 'IR reverb tail (E4)',
      method: 'play into bar 8 → stop → mute Keys (kills the dry voice + the send input) → the convolver tail vs the decayed floor',
      run: async () => {
        await ctx.stopTransport();
        await playFrom(15.0);
        await sleep(2200);
        post({ type: 'transport-stop' });
        await sleep(120);
        post({ type: 'set-track-mute', trackId: 1, mute: true });   // dry + send die
        await sleep(280);
        const tail = await ctx.meanBandDb(293.7, 550);               // D4 — bar 8's chord
        await sleep(3600);                                           // ~10 τ (0.35 s)
        const floor = await ctx.meanBandDb(293.7, 500);
        post({ type: 'set-track-mute', trackId: 1, mute: false });
        await sleep(150);
        return { pass: (tail - floor) >= 6.0,
          measured: 'tail ' + tail.toFixed(1) + ' dB vs floor ' + floor.toFixed(1)
            + ' dB → ' + (tail - floor).toFixed(1) + ' dB (≥ 6; the convolver rings past its dead input)' };
      },
    },

    V8: {
      name: 'Varispeed physics (E4e)',
      method: 'the 440 Hz sine clip, speed ×2 (others muted) · the (dominant freq, content end) PAIR',
      run: async () => {
        await ctx.stopTransport();
        const ts = await ctx.ensureTestSine();
        const mutes = await ctx.muteTracks([0, 1, 2]);
        const sp = await postW({ type: 'set-wave-clip-speed', trackId: ts.trackId,
          clipIdx: ts.clipIdx, ratio: 2.0 }, 'wave-clip-speed-set',
          (m) => m.clipIdx === ts.clipIdx, 8000);
        const tPlay = await playFrom(0);
        await sleep(250);
        const f = await dominant(200, 2000);
        const ce = await contentEnd(tPlay, f, 0.55, 1.9);
        await ctx.stopTransport();
        await postW({ type: 'set-wave-clip-speed', trackId: ts.trackId,
          clipIdx: ts.clipIdx, ratio: 1.0 }, 'wave-clip-speed-set',
          (m) => m.clipIdx === ts.clipIdx, 8000);
        await ctx.restoreMutes(mutes);
        await ctx.cleanupTestSine();
        const fRatio = f / 440.0;
        return { pass: !!sp && sp.rc === 0 && Math.abs(fRatio - 2) <= 0.2
            && ce.ce != null && Math.abs(ce.ce - 1.0) <= 0.25,
          measured: 'speed rc=' + (sp && sp.rc) + ' · pair (freq ' + f.toFixed(1) + ' Hz = '
            + fRatio.toFixed(2) + '×440, content end ' + (ce.ce == null ? '—' : ce.ce.toFixed(2))
            + ' s vs 1.00) — the pair discriminator: BOTH shift pitch, only varispeed halves the content' };
      },
    },

    V9: {
      name: 'Pitch STFT (E4c/E4e)',
      method: 'the sine clip, pitch +5 st · dominant ×2^(5/12) AND content end unchanged (±6 %)',
      run: async () => {
        await ctx.stopTransport();
        const ts = await ctx.ensureTestSine();
        const mutes = await ctx.muteTracks([0, 1, 2]);
        const pi = await postW({ type: 'set-wave-clip-pitch', trackId: ts.trackId,
          clipIdx: ts.clipIdx, semitones: 5 }, 'wave-clip-pitch-set',
          (m) => m.clipIdx === ts.clipIdx, 8000);
        const tPlay = await playFrom(0);
        await sleep(250);
        const fExp = 440 * Math.pow(2, 5 / 12);
        const f = await dominant(200, 900);
        const ce = await contentEnd(tPlay, f, 0.8, 2.9);
        await ctx.stopTransport();
        await postW({ type: 'set-wave-clip-pitch', trackId: ts.trackId,
          clipIdx: ts.clipIdx, semitones: 0 }, 'wave-clip-pitch-set',
          (m) => m.clipIdx === ts.clipIdx, 8000);
        await ctx.restoreMutes(mutes);
        await ctx.cleanupTestSine();
        const fErr = Math.abs(f / fExp - 1);
        const ceErr = ce.ce == null ? 1 : Math.abs(ce.ce - 2.0);
        const ceStr = ce.ce == null ? '—'
          : ce.ce.toFixed(2) + ' s vs 2.00 = ' + (ceErr * 100).toFixed(1) + '% err';
        return { pass: !!pi && pi.rc === 0 && fErr <= 0.06 && ceErr <= 0.13,
          measured: 'pitch rc=' + (pi && pi.rc) + ' · pair (freq ' + f.toFixed(1) + ' Hz vs '
            + fExp.toFixed(1) + ' = ' + (fErr * 100).toFixed(1) + '% err, content end ' + ceStr
            + ') — duration PRESERVED = the STFT, not varispeed' };
      },
    },

    V10: {
      name: 'Bounce ≈ live (E3)',
      method: 'bounce 0→19.2 s (master chain) + analyse RMS vs the AnalyserNode on a parked play [1, 2] s',
      run: async () => {
        await ctx.stopTransport();
        const { analysis } = await ctx.ensureBounceAndAnalysis();
        await playFrom(0);
        await sleep(350);
        const live = await ctx.meanRms(900);
        await ctx.stopTransport();
        const file = dbToLin(analysis.rmsDb);
        const ratio = file > 0 ? live / file : 0;
        return { pass: ratio >= 0.8 && ratio <= 1.25,
          measured: 'file RMS ' + (analysis.rmsDb != null ? analysis.rmsDb.toFixed(2) : '—')
            + ' dBFS · live RMS ' + linToDbStr(live) + ' dBFS → ratio ' + ratio.toFixed(3)
            + ' (window 0.8–1.25; the live ×1/√2 path scalar vs the master-render ×0.7071 cancel — §6g.1/§6k.5)' };
      },
    },

    V11: {
      name: 'True-peak ≥ sample peak (E4d)',
      method: 'analyse JSON: truePeakDb − peakDb (the 4× oversampled ISP)',
      run: async () => {
        const { analysis } = await ctx.ensureBounceAndAnalysis();
        const d = analysis.truePeakDb - analysis.peakDb;
        return { pass: d >= -0.01,
          measured: 'truePeak ' + analysis.truePeakDb.toFixed(2) + ' − peak '
            + analysis.peakDb.toFixed(2) + ' = ' + d.toFixed(2) + ' dB (typical 0.3–2)' };
      },
    },

    V12: {
      name: 'Undo/redo clip ops (E2d)',
      method: 'split a Drums clip at its midpoint → count +1 · undo → restored · redo · undo',
      run: async () => {
        await ctx.stopTransport();
        const clips = (state.tracks[0] && state.tracks[0].clips) || [];
        const clip = clips[0];
        if (!clip) throw new Error('no drum clip (deleted?) — rebuild to reset');
        const before = (await postW({ type: 'num-wave-clips', trackId: 0 }, 'num-wave-clips',
          (m) => m.trackId === 0, 8000)).num;
        await postW({ type: 'undo-begin', name: 'V12 split' }, 'undo-begun', null, 8000);
        const at = clip.start + clip.length / 2;
        const sp = await postW({ type: 'split-clip', itemId: clip.itemId, splitSec: at },
          'clip-split', (m) => Number(m.itemId) === Number(clip.itemId), 8000);
        const afterSplit = (await postW({ type: 'num-wave-clips', trackId: 0 }, 'num-wave-clips',
          (m) => m.trackId === 0, 8000)).num;
        const u1 = await postW({ type: 'undo' }, 'undo-done', null, 8000);
        const afterUndo = (await postW({ type: 'num-wave-clips', trackId: 0 }, 'num-wave-clips',
          (m) => m.trackId === 0, 8000)).num;
        const r1 = await postW({ type: 'redo' }, 'redo-done', null, 8000);
        const afterRedo = (await postW({ type: 'num-wave-clips', trackId: 0 }, 'num-wave-clips',
          (m) => m.trackId === 0, 8000)).num;
        const u2 = await postW({ type: 'undo' }, 'undo-done', null, 8000);
        const final = (await postW({ type: 'num-wave-clips', trackId: 0 }, 'num-wave-clips',
          (m) => m.trackId === 0, 8000)).num;
        await ctx.refreshClipMirror(0);
        const ok = sp && sp.newItemId > 0 && afterSplit === before + 1 && afterUndo === before
          && afterRedo === before + 1 && final === before && u1 && u2 && r1
          && u1.rc === 0 && u2.rc === 0 && r1.rc === 0;
        return { pass: !!ok,
          measured: before + ' → split ' + afterSplit + ' → undo ' + afterUndo
            + ' → redo ' + afterRedo + ' → undo ' + final };
      },
    },

    V13: {
      name: 'Persistence round-trip (Phase-12 pattern)',
      method: 'get-edit-xml → load-edit-xml (rebuild) → re-register ALL runtime assets (drum buffers, sfizz samples+SFZ, IR) + live input → introspection + audible band',
      run: async () => {
        await ctx.stopTransport();
        const x = await postW({ type: 'get-edit-xml' }, 'edit-xml', null, 10000);
        if (!x || !x.xml) throw new Error('no edit xml');
        post({ type: 'load-edit-xml', xml: x.xml });
        const ready = await waitFor('ready', 40000, (m) => m.fromState === true);
        const loaded = await waitFor('edit-loaded', 15000, (m) => m.rc === 0);
        if (!ready || !loaded) throw new Error('load-edit-xml failed (ready=' + !!ready + ')');
        await sleep(300);
        // the runtime assets are ALL gone in the fresh instance (§6j.7)
        post({ type: 'set-bpm', bpm: C.BPM });
        await sleep(150);
        for (let s = 0; s < 4; s++) {
          const info = state.drumPcms[s];
          const r = await postW({ type: 'register-audio-buffer', name: 'drums_' + (s + 1),
            pcm: info.pcm, numFrames: info.frames, numChannels: 2, sampleRate: C.SAMPLE_RATE },
            'audio-buffer-registered', (m) => m.name === 'drums_' + (s + 1), 20000);
          if (!r || r.rc !== 0) throw new Error('re-register drums_' + (s + 1));
        }
        const resynth = ctx.resynth;
        for (const [tid, centers, mk, sfz] of [
          [1, ctx.constants.EP_CENTERS, resynth.epSample, resynth.epSfz],
          [2, ctx.constants.BASS_CENTERS, resynth.bassSample, resynth.bassSfz],
        ]) {
          for (const c of centers) {
            const data = mk(c);
            const r = await postW({ type: 'sfizz-register-sample', trackId: tid,
              name: (tid === 1 ? 'ep_' : 'bass_') + c + '.wav', data,
              numFrames: data.length / 2, numChannels: 2, sampleRate: C.SAMPLE_RATE },
              'sfizz-sample-registered', (m) => m.trackId === tid, 20000);
            if (!r || r.rc !== 0) throw new Error('re-register sfizz ' + c);
          }
          const l = await postW({ type: 'sfizz-load-string', trackId: tid, text: sfz(), wait: 1 },
            'sfizz-loaded', (m) => m.trackId === tid, 20000);
          if (!l || l.rc !== 0) throw new Error('re-load-string ' + tid);
        }
        const irBytes = resynth.irWav();
        const ir = await postW({ type: 'ir-load-data', trackId: state.busTrackId, pluginIdx: 0,
          bytes: irBytes }, 'ir-loaded', null, 15000, [irBytes]);
        if (!ir || ir.rc !== 0) onWarnLocal('ir re-load rc=' + (ir && ir.rc) + ' (the XML may already carry it — Route C)');
        post({ type: 'select-input-track', trackId: 1 });
        await sleep(200);
        await postW({ type: 'enable-live-input' }, 'live-input-enabled', null, 10000);
        // introspection against the baseline (+ the scratch track if present)
        const nt = await postW({ type: 'num-tracks' }, 'track-count', null, 8000);
        const wc = await postW({ type: 'num-wave-clips', trackId: 0 }, 'num-wave-clips',
          (m) => m.trackId === 0, 8000);
        const rg1 = await postW({ type: 'sfizz-num-regions', trackId: 1 }, 'sfizz-region-count',
          (m) => m.trackId === 1, 8000);
        const cp = await postW({ type: 'automation-get-num-points', trackId: C.CURVE.trackId,
          pluginIdx: C.CURVE.pluginIdx, paramId: C.CURVE.paramId }, 'automation-num-points', null, 8000);
        const exp = state.baseline;
        const intsOk = nt && nt.numTracks === exp.numTracks + (state.testSine ? 1 : 0)
          && wc && wc.num === exp.waveClips0 && rg1 && rg1.numRegions === exp.regions[1]
          && cp && cp.count === exp.curvePoints;
        // the audible leg
        await playFrom(0);
        await sleep(150);
        const r = await bandPair(164.8, 205, 800);
        await ctx.stopTransport();
        await ctx.refreshClipMirror(0);
        await ctx.refreshCurveMirror();
        return { pass: intsOk && r.delta >= 6.0,
          measured: 'xml ' + x.xml.length + ' B · tracks ' + (nt && nt.numTracks)
            + ' · waveClips ' + (wc && wc.num) + ' · regions ' + (rg1 && rg1.numRegions)
            + ' · curve ' + (cp && cp.count) + ' pts · audible E3 band ' + r.delta.toFixed(1)
            + ' dB over neighbour' };
      },
    },

    V14: {
      name: 'Realtime safety under load',
      method: 'reset → play 3 s (IR + all tracks) → the engine\'s block/render drop counters',
      run: async () => {
        await ctx.stopTransport();
        await postW({ type: 'reset-drop-counters' }, 'drop-counters-reset', null, 8000);
        await playFrom(0);
        await sleep(3000);
        await ctx.stopTransport();
        const bd = await postW({ type: 'get-block-drop-count' }, 'block-drop-count', null, 8000);
        const rd = await postW({ type: 'get-render-drop-count' }, 'render-drop-count', null, 8000);
        const b = bd ? bd.count : -1, r = rd ? rd.count : -1;
        return { pass: b === 0 && r === 0,
          measured: 'block ' + b + ' / render ' + r
            + ' (0-assertion instrument honesty: a 0 means no drops were COUNTED — the liveness is the build-time symbol assertion; browser-side output glitches are a separate channel)' };
      },
    },
  };

  function onWarnLocal(msg) { ctx.onWarn ? ctx.onWarn(msg) : console.warn(msg); }
  function linToDbStr(lin) { return lin > 0 ? (20 * Math.log10(lin)).toFixed(2) : '−∞'; }

  const ORDER = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14'];
  const resultsMap = new Map();
  let onUpdateCb = null;
  let running = false;

  function emit(id, status, measured) {
    resultsMap.set(id, { status, measured, at: Date.now() });
    if (onUpdateCb) onUpdateCb(id, status, measured);
  }

  async function run(id) {
    const test = TESTS[id];
    if (!test) throw new Error('unknown test ' + id);
    if (running) { emit(id, 'fail', 'another test is running'); return resultsMap.get(id); }
    if (!state.built) { emit(id, 'fail', 'build the arrangement first (button 2)'); return resultsMap.get(id); }
    running = true;
    emit(id, 'running', null);
    try {
      const r = await test.run();
      emit(id, r.pass ? 'pass' : 'fail', r.measured);
    } catch (e) {
      emit(id, 'fail', 'ERROR: ' + String(e));
    } finally {
      running = false;
    }
    return resultsMap.get(id);
  }

  async function runAll() {
    for (const id of ORDER) {
      await run(id);
      await sleep(300);
    }
    return results();
  }

  function results() {
    const out = {};
    for (const id of ORDER) out[id] = resultsMap.get(id) || { status: 'pending', measured: null };
    return out;
  }

  return {
    rows: () => ORDER.map((id) => ({ id, name: TESTS[id].name, method: TESTS[id].method })),
    run, runAll, results,
    onUpdate(cb) { onUpdateCb = cb; },
  };
}
