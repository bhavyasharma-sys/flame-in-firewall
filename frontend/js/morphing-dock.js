/**
 * Ignis — Floating Morphing Chat Bar & Compact ChatGPT-Style Voice Recorder
 *
 * Hovers cleanly in the lower center of the viewport across all Ignis tabs:
 *   - Left mode-switcher pill with blur-morph icon transitions
 *   - Per-character 3D spring-flip animated placeholder text
 *   - Compact inline Voice Recorder pill right beside Send (never takes over the whole bar!):
 *       • Live 60 FPS AudioContext scrolling waveform canvas + pulsing dot + tabular timer
 *       • Stop (✓): finishes listening and writes the entire transcript into the chat input
 *       • Send (↑ / Enter) while recording: automatically retrieves everything spoken and sends it
 *       • Discard (Trash / Escape): cancels cleanly without modifying existing input text
 *       • Dual engine: continuous Web Speech API + MediaRecorder /api/transcribe fallback
 */

import { api } from './api.js';
import { getPreferences } from './preferences.js';
import { emit, esc, on, state } from './state.js';

const MODES = [
  {
    id: 'ask',
    label: 'Ask FlameAI',
    placeholder: 'Ask FlameAI anything...',
    icon: '<path d="M12 3l1.9 4.8L19 9.5l-5.1 1.7L12 16l-1.9-4.8L5 9.5l5.1-1.7z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  },
  {
    id: 'plot',
    label: 'Plot Chart',
    placeholder: 'Plot flame spread or LOI...',
    icon: '<path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/>',
  },
  {
    id: 'audit',
    label: 'Audit Cabin',
    placeholder: 'Audit active cabin fire risk...',
    icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  },
  {
    id: 'search',
    label: 'Search NASA',
    placeholder: 'Search runs, papers & fuels...',
    icon: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  },
];

// Live waveform constants adapted from AiRecorder
const SAMPLE_MS = 50;
const BAR_W = 2.5;
const BAR_GAP = 2;

let activeModeIdx = 0;
let statusHideTimer = null;

// Voice Recorder Session State
let recPhase = 'idle'; // 'idle' | 'recording' | 'transcribing'
let recognition = null;
let recStopResolve = null;
let committedFinal = '';
let segmentFinal = '';
let segmentInterim = '';
let sttErrorCode = null;
let sttSupported = false;

let mediaStream = null;
let audioCtx = null;
let analyser = null;
let mediaRecorder = null;
let audioChunks = [];
let recorderMime = 'audio/webm';

let waveRaf = 0;
let recStartTs = 0;
let speechEnergy = 0;
let finalizingPromise = null;

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

function fmtTimer(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function showStatusPill(message, { variant = 'info', sticky = false, duration = 2800 } = {}) {
  const pill = document.getElementById('mi-status-pill');
  if (!pill) return;
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }
  pill.textContent = message;
  pill.dataset.variant = variant;
  pill.classList.add('is-visible');
  if (!sticky) {
    statusHideTimer = setTimeout(() => {
      pill.classList.remove('is-visible');
    }, duration);
  }
}

function hideStatusPill() {
  const pill = document.getElementById('mi-status-pill');
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }
  pill?.classList.remove('is-visible');
}

function renderAnimatedPlaceholder(text, animate = true) {
  const stage = document.getElementById('mi-placeholder-stage');
  if (!stage) return;

  const reduce = prefersReducedMotion() || !animate;
  const oldRow = stage.querySelector('.mi-ph-row:not(.is-exiting)');
  if (oldRow) {
    if (reduce) {
      oldRow.remove();
    } else {
      oldRow.classList.add('is-exiting');
      oldRow.querySelectorAll('.mi-char').forEach((ch, idx) => {
        ch.style.animationDelay = `${idx * 12}ms`;
      });
      setTimeout(() => oldRow.remove(), 420 + text.length * 12);
    }
  }

  const row = document.createElement('div');
  row.className = `mi-ph-row${reduce ? ' is-instant' : ''}`;
  row.setAttribute('aria-hidden', 'true');

  const letters = Array.from(text);
  row.innerHTML = letters
    .map((ch, idx) => {
      const safe = ch === ' ' ? '&nbsp;' : esc(ch);
      const delay = reduce ? 0 : idx * 15;
      return `<span class="mi-char" style="animation-delay:${delay}ms;">${safe}</span>`;
    })
    .join('');

  stage.appendChild(row);
}

function renderModeIcon(mode, animate = true) {
  const slot = document.getElementById('mi-mode-icon-slot');
  const btn = document.getElementById('mi-mode-btn');
  if (!slot) return;
  const reduce = prefersReducedMotion() || !animate;

  if (btn) {
    btn.title = `Mode: ${mode.label} (click to switch)`;
    btn.setAttribute('aria-label', `Switch input mode. Current mode: ${mode.label}`);
  }

  const oldEl = slot.querySelector('.mi-mode-icon:not(.is-exiting)');
  if (oldEl) {
    if (reduce) {
      oldEl.remove();
    } else {
      oldEl.classList.add('is-exiting');
      setTimeout(() => oldEl.remove(), 340);
    }
  }

  const nextEl = document.createElement('span');
  nextEl.className = `mi-mode-icon${reduce ? ' is-instant' : ''}`;
  nextEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mode.icon}</svg>`;
  slot.appendChild(nextEl);
}

function getLiveTranscript() {
  return [committedFinal, segmentFinal, segmentInterim]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function syncPlaceholderVisibility() {
  const input = document.getElementById('mi-input');
  const stage = document.getElementById('mi-placeholder-stage');
  const sendBtn = document.getElementById('mi-send-btn');
  if (!input) return;
  const hasVal = input.value.length > 0;
  if (stage) stage.classList.toggle('is-hidden', hasVal);
  const canSend = input.value.trim().length > 0 || recPhase === 'recording';
  if (sendBtn) sendBtn.classList.toggle('has-text', canSend);
}

function setRecorderPhaseUI(nextPhase) {
  recPhase = nextPhase;
  const dock = document.getElementById('morphing-chat-dock');
  const recWrap = document.getElementById('mi-recorder-wrap');
  const micBtn = document.getElementById('mi-mic-btn');
  const stopBtn = document.getElementById('mi-rec-stop');

  dock?.classList.toggle('is-listening', nextPhase === 'recording');
  dock?.classList.toggle('is-transcribing', nextPhase === 'transcribing');
  recWrap?.classList.toggle('is-recording', nextPhase === 'recording');
  recWrap?.classList.toggle('is-transcribing', nextPhase === 'transcribing');

  if (micBtn) {
    micBtn.setAttribute('aria-pressed', String(nextPhase === 'recording'));
  }
  if (stopBtn) {
    stopBtn.disabled = nextPhase === 'transcribing';
  }
  syncPlaceholderVisibility();
}

function stopWaveformLoop() {
  if (waveRaf) {
    cancelAnimationFrame(waveRaf);
    waveRaf = 0;
  }
  const canvas = document.getElementById('mi-rec-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function startWaveformLoop() {
  stopWaveformLoop();
  const canvas = document.getElementById('mi-rec-canvas');
  const timerEl = document.getElementById('mi-rec-timer');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const reduce = prefersReducedMotion();
  const samples = [];
  const buf = new Uint8Array(512);
  let lastSample = performance.now();
  let shownSec = -1;
  let W = 0;
  let H = 0;

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    W = r.width || 48;
    H = r.height || 22;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  const sampleLevel = (now) => {
    if (analyser) {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      const n = Math.min(analyser.fftSize, buf.length);
      for (let i = 0; i < n; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / n) * 4.8;
      if (rms > 0.04) return clamp(rms, 0.1, 1);
    }
    // Smooth fallback cadence reactive to SpeechRecognition activity
    const t = now / 1000;
    const pulse = 0.12 + speechEnergy * (0.45 + 0.43 * Math.abs(Math.sin(t * 7.4) * Math.cos(t * 3.1)));
    speechEnergy = Math.max(0.06, speechEnergy * 0.94);
    return clamp(pulse, 0.1, 0.95);
  };

  const tick = (now) => {
    if (recPhase !== 'recording') return;
    if (W < 4) resize();

    while (now - lastSample >= SAMPLE_MS) {
      lastSample += SAMPLE_MS;
      samples.push(sampleLevel(lastSample));
      if (samples.length > 96) samples.shift();
    }

    const elapsedMs = now - recStartTs;
    const sec = Math.floor(elapsedMs / 1000);
    if (sec !== shownSec && timerEl) {
      shownSec = sec;
      timerEl.textContent = fmtTimer(elapsedMs);
    }

    ctx.clearRect(0, 0, W, H);
    const barColor = getComputedStyle(canvas).color || '#ff521b';
    ctx.fillStyle = barColor;
    const step = BAR_W + BAR_GAP;
    const shift = !reduce ? ((now - lastSample) / SAMPLE_MS) * step : 0;
    const count = Math.ceil(W / step) + 1;

    for (let i = 0; i < count; i++) {
      const v = samples[samples.length - 1 - i] ?? 0.08;
      const x = W - BAR_W - i * step - shift + step;
      if (x < -BAR_W) break;
      const h = Math.max(BAR_W, v * H);
      const edgeFade = clamp(x / (W * 0.28), 0.18, 1);
      ctx.globalAlpha = 0.88 * edgeFade;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, (H - h) / 2, BAR_W, h, BAR_W / 2);
      } else {
        ctx.rect(x, (H - h) / 2, BAR_W, h);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    waveRaf = requestAnimationFrame(tick);
  };

  waveRaf = requestAnimationFrame(tick);
}

function releaseMediaResources() {
  stopWaveformLoop();
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  analyser = null;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
}

function startSpeechRecognitionEngine() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  sttSupported = Boolean(SpeechRec);
  if (!SpeechRec) return false;

  try {
    const rec = new SpeechRec();
    const savedLang = getPreferences().voiceLang;
    rec.lang = savedLang && savedLang !== 'auto' ? savedLang : navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      speechEnergy = 0.45;
    };

    rec.onspeechstart = () => {
      speechEnergy = 0.85;
    };

    rec.onresult = (event) => {
      let finals = '';
      let interims = '';
      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        const text = (res[0]?.transcript || '').trim();
        if (!text) continue;
        if (res.isFinal) {
          finals += (finals ? ' ' : '') + text;
        } else {
          interims += (interims ? ' ' : '') + text;
        }
      }
      segmentFinal = finals;
      segmentInterim = interims;
      speechEnergy = 0.92;

      const live = getLiveTranscript();
      if (live && recPhase === 'recording') {
        const clipped = live.length > 68 ? `…${live.slice(-67)}` : live;
        showStatusPill(`"${clipped}"`, { variant: 'listening', sticky: true });
      }
    };

    rec.onerror = (event) => {
      const code = event.error || 'unknown';
      sttErrorCode = code;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        discardRecording({ silent: true });
        showStatusPill(
          'Microphone blocked — allow mic permission in your browser (or open preview in a new tab).',
          { variant: 'warn', duration: 4800 }
        );
      } else if (code === 'audio-capture') {
        discardRecording({ silent: true });
        showStatusPill('No microphone detected on this device.', {
          variant: 'warn',
          duration: 3600,
        });
      }
    };

    rec.onend = () => {
      // Preserve everything finalized in this recognition segment
      if (segmentFinal.trim()) {
        committedFinal = [committedFinal, segmentFinal.trim()].filter(Boolean).join(' ');
        segmentFinal = '';
      }

      // If user is still actively recording (not stopping/discarding), auto-restart cleanly
      if (
        recPhase === 'recording' &&
        recognition === rec &&
        sttErrorCode !== 'not-allowed' &&
        sttErrorCode !== 'service-not-allowed' &&
        sttErrorCode !== 'audio-capture' &&
        sttErrorCode !== 'network'
      ) {
        if (segmentInterim.trim()) {
          committedFinal = [committedFinal, segmentInterim.trim()].filter(Boolean).join(' ');
          segmentInterim = '';
        }
        try {
          rec.start();
          return;
        } catch {
          // ignore restart race
        }
      }

      if (recStopResolve) {
        const done = recStopResolve;
        recStopResolve = null;
        done();
      }
    };

    recognition = rec;
    rec.start();
    return true;
  } catch (err) {
    sttErrorCode = err?.name || 'start-failed';
    recognition = null;
    return false;
  }
}

async function attachMicrophoneAudioStream() {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // If user stopped or discarded while permission prompt was open, release immediately
    if (recPhase !== 'recording') {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }

    mediaStream = stream;
    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (AudioCtor) {
        const ctx = new AudioCtor();
        if (ctx.state === 'suspended') {
          await ctx.resume().catch(() => {});
        }
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        an.smoothingTimeConstant = 0.55;
        ctx.createMediaStreamSource(stream).connect(an);
        audioCtx = ctx;
        analyser = an;
      }
    } catch {
      // Live waveform gracefully falls back to cadence animation
    }

    // Record audio chunks as backup for /api/transcribe if browser STT fails or is unsupported
    if (typeof MediaRecorder !== 'undefined') {
      try {
        const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
        const supportedMime = preferred.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
        const mr = supportedMime
          ? new MediaRecorder(stream, { mimeType: supportedMime })
          : new MediaRecorder(stream);
        recorderMime = mr.mimeType || supportedMime || 'audio/webm';
        audioChunks = [];
        mr.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };
        mr.start(250);
        mediaRecorder = mr;
      } catch {
        mediaRecorder = null;
      }
    }
    return true;
  } catch (err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      // Only abort if browser SpeechRecognition isn't actively working either
      if (!recognition || sttErrorCode === 'not-allowed') {
        discardRecording({ silent: true });
        showStatusPill(
          'Microphone permission denied — allow mic access in browser settings or open in a new tab.',
          { variant: 'warn', duration: 4800 }
        );
      }
    } else if (!recognition) {
      discardRecording({ silent: true });
      showStatusPill('No microphone available on this device.', {
        variant: 'warn',
        duration: 3400,
      });
    }
    return false;
  }
}

function startRecording() {
  if (recPhase !== 'idle') return;

  committedFinal = '';
  segmentFinal = '';
  segmentInterim = '';
  sttErrorCode = null;
  audioChunks = [];
  recStartTs = performance.now();

  const timerEl = document.getElementById('mi-rec-timer');
  if (timerEl) timerEl.textContent = '0:00';

  const hasBrowserStt = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const hasMediaRec = Boolean(navigator.mediaDevices?.getUserMedia);
  if (!hasBrowserStt && !hasMediaRec) {
    showStatusPill('Voice dictation is not supported in this browser.', {
      variant: 'warn',
      duration: 3600,
    });
    return;
  }

  setRecorderPhaseUI('recording');
  showStatusPill('Listening… click ✓ to insert or Send to ask', {
    variant: 'listening',
    sticky: true,
  });

  // 1. Start Web Speech Recognition synchronously inside the click gesture
  startSpeechRecognitionEngine();

  // 2. Start compact live scrolling waveform canvas
  startWaveformLoop();

  // 3. Attach live mic AnalyserNode + MediaRecorder backup asynchronously
  void attachMicrophoneAudioStream();
}

function stopMediaRecorderForBlob() {
  return new Promise((resolve) => {
    const mr = mediaRecorder;
    mediaRecorder = null;
    if (!mr || mr.state === 'inactive') {
      resolve(audioChunks.length ? new Blob(audioChunks, { type: recorderMime }) : null);
      return;
    }
    const timer = setTimeout(() => {
      resolve(audioChunks.length ? new Blob(audioChunks, { type: recorderMime }) : null);
    }, 650);
    mr.onstop = () => {
      clearTimeout(timer);
      resolve(audioChunks.length ? new Blob(audioChunks, { type: recorderMime }) : null);
    };
    try {
      mr.stop();
    } catch {
      clearTimeout(timer);
      resolve(audioChunks.length ? new Blob(audioChunks, { type: recorderMime }) : null);
    }
  });
}

function stopSpeechRecognitionAndFlush() {
  return new Promise((resolve) => {
    const rec = recognition;
    recognition = null;
    if (!rec) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      recStopResolve = null;
      resolve();
    };
    recStopResolve = finish;
    setTimeout(finish, 750);
    try {
      rec.stop();
    } catch {
      finish();
    }
  });
}

async function transcribeBlobFallback(blob) {
  if (!blob || blob.size < 400) return { transcript: '', error: 'empty_audio' };
  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });
    if (!res.ok) return { transcript: '', error: `http_${res.status}` };
    return await res.json();
  } catch (err) {
    return { transcript: '', error: err?.message || 'network' };
  }
}

/**
 * Stops active recording, awaits final speech flush (with optional server Whisper fallback),
 * releases microphone hardware, and returns the full captured transcript.
 */
async function stopAndRetrieveTranscript({ autoSend = false } = {}) {
  if (finalizingPromise) return finalizingPromise;
  if (recPhase !== 'recording') return '';

  setRecorderPhaseUI('transcribing');
  showStatusPill(autoSend ? 'Transcribing & sending…' : 'Transcribing voice…', {
    variant: 'listening',
    sticky: true,
  });

  finalizingPromise = (async () => {
    const [blob] = await Promise.all([
      stopMediaRecorderForBlob(),
      stopSpeechRecognitionAndFlush(),
    ]);
    releaseMediaResources();

    let transcript = getLiveTranscript();

    // If browser SpeechRecognition produced nothing (e.g. Firefox or network block), try backend Whisper
    if (!transcript && blob && blob.size > 400) {
      const serverRes = await transcribeBlobFallback(blob);
      if (serverRes?.transcript) {
        transcript = serverRes.transcript.trim();
      }
    }

    committedFinal = '';
    segmentFinal = '';
    segmentInterim = '';
    audioChunks = [];
    setRecorderPhaseUI('idle');
    finalizingPromise = null;
    return transcript;
  })();

  return finalizingPromise;
}

function discardRecording({ silent = false } = {}) {
  recPhase = 'idle';
  const rec = recognition;
  recognition = null;
  if (rec) {
    try {
      rec.onend = null;
      rec.abort();
    } catch {
      // ignore
    }
  }
  const mr = mediaRecorder;
  mediaRecorder = null;
  if (mr && mr.state !== 'inactive') {
    try {
      mr.onstop = null;
      mr.stop();
    } catch {
      // ignore
    }
  }
  releaseMediaResources();
  committedFinal = '';
  segmentFinal = '';
  segmentInterim = '';
  audioChunks = [];
  setRecorderPhaseUI('idle');
  if (!silent) {
    showStatusPill('Recording discarded', { variant: 'info', duration: 1600 });
  }
}

/**
 * ChatGPT-style Stop (✓): finishes listening and writes the entire spoken transcript into the chat input.
 */
async function stopAndInsertIntoInput() {
  const input = document.getElementById('mi-input');
  const transcript = await stopAndRetrieveTranscript({ autoSend: false });
  if (!input) return;

  if (transcript) {
    const existing = input.value.trim();
    input.value = existing ? `${existing} ${transcript}` : transcript;
    syncPlaceholderVisibility();
    input.focus();
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {
      // ignore
    }
    showStatusPill('Transcript ready — edit or press Send', {
      variant: 'ok',
      duration: 2600,
    });
  } else if (sttErrorCode === 'network') {
    showStatusPill(
      'Browser speech service blocked on this network — try Chrome/Edge in a regular tab.',
      { variant: 'warn', duration: 4200 }
    );
  } else if (!sttSupported) {
    showStatusPill(
      'Use Chrome, Edge, or Safari for built-in voice dictation.',
      { variant: 'warn', duration: 3800 }
    );
  } else {
    showStatusPill('No speech detected — tap the mic and speak clearly.', {
      variant: 'info',
      duration: 2800,
    });
  }
}

/**
 * ChatGPT-style Send: if mic is currently listening, automatically retrieves everything spoken
 * and immediately dispatches the full prompt!
 */
async function submitMorphingInput() {
  const input = document.getElementById('mi-input');
  if (!input) return;

  if (recPhase === 'recording') {
    const transcript = await stopAndRetrieveTranscript({ autoSend: true });
    if (transcript) {
      const existing = input.value.trim();
      input.value = existing ? `${existing} ${transcript}` : transcript;
      syncPlaceholderVisibility();
    } else if (!input.value.trim()) {
      showStatusPill('No speech captured to send — try speaking again.', {
        variant: 'info',
        duration: 2600,
      });
      return;
    }
  } else if (recPhase === 'transcribing') {
    return;
  }

  hideStatusPill();
  const raw = input.value.trim();
  const mode = MODES[activeModeIdx];

  if (!raw) {
    if (mode.id === 'audit') {
      const c = state.activeCabin;
      emit(
        'chat:ask',
        `Audit my active cabin configuration (${c.oxygen_pct}% O2, ${c.pressure_kpa} kPa, ${c.flow_velocity_cm_s} cm/s airflow, ${c.gravity_g}g, ${c.fuel_material}) using exact Shapley risk attribution and NASA mitigation directives.`
      );
      return;
    }
    input.focus();
    return;
  }

  input.value = '';
  syncPlaceholderVisibility();

  if (mode.id === 'plot') {
    const wantsPlot = /\b(plot|chart|graph|curve|diagram)\b/i.test(raw);
    const prompt = wantsPlot ? raw : `Plot a scientific chart and explain: ${raw}`;
    emit('chat:ask', prompt);
    return;
  }

  if (mode.id === 'audit') {
    const c = state.activeCabin;
    emit(
      'chat:ask',
      `Considering active cabin (${c.oxygen_pct}% O2, ${c.pressure_kpa} kPa, ${c.flow_velocity_cm_s} cm/s, ${c.gravity_g}g, ${c.fuel_material}): ${raw}`
    );
    return;
  }

  if (mode.id === 'search') {
    try {
      const res = await api.search(raw);
      const top = (res.results || [])[0];
      if (top) {
        showStatusPill(`Opening ${top.type}: ${top.title}`, { variant: 'ok', duration: 2200 });
        emit('search:open-item', top);
        return;
      }
    } catch {
      // fall back to FlameAI chat
    }
    emit('chat:ask', raw);
    return;
  }

  emit('chat:ask', raw);
}

export function initMorphingDock() {
  const modeBtn = document.getElementById('mi-mode-btn');
  const input = document.getElementById('mi-input');
  const micBtn = document.getElementById('mi-mic-btn');
  const discardBtn = document.getElementById('mi-rec-discard');
  const stopBtn = document.getElementById('mi-rec-stop');
  const sendBtn = document.getElementById('mi-send-btn');
  const form = document.getElementById('mi-form');
  if (!modeBtn || !input || !form) return;

  renderModeIcon(MODES[activeModeIdx], false);
  renderAnimatedPlaceholder(MODES[activeModeIdx].placeholder, false);
  syncPlaceholderVisibility();

  modeBtn.addEventListener('click', () => {
    activeModeIdx = (activeModeIdx + 1) % MODES.length;
    const mode = MODES[activeModeIdx];
    modeBtn.classList.remove('is-tapped');
    void modeBtn.offsetWidth;
    modeBtn.classList.add('is-tapped');
    setTimeout(() => modeBtn.classList.remove('is-tapped'), 160);

    renderModeIcon(mode, true);
    renderAnimatedPlaceholder(mode.placeholder, true);
    showStatusPill(`Mode: ${mode.label}`, { variant: 'info', duration: 1700 });
    input.focus();
  });

  input.addEventListener('input', syncPlaceholderVisibility);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submitMorphingInput();
  });

  sendBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    void submitMorphingInput();
  });

  micBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    if (recPhase === 'idle') {
      startRecording();
    } else if (recPhase === 'recording') {
      void stopAndInsertIntoInput();
    }
  });

  stopBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    void stopAndInsertIntoInput();
  });

  discardBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    discardRecording();
  });

  // Global keyboard shortcuts: Alt+M toggles mic, Escape discards recording, Enter sends while recording
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      if (recPhase === 'idle') startRecording();
      else if (recPhase === 'recording') void stopAndInsertIntoInput();
    } else if (e.key === 'Escape' && recPhase === 'recording') {
      e.preventDefault();
      discardRecording();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && recPhase === 'recording') {
      void stopAndInsertIntoInput();
    }
  });

  on('tab:changed', (tab) => {
    document.body.classList.toggle('on-chat-tab', tab === 'chat');
  });
}
