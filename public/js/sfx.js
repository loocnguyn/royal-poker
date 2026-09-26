// Hiệu ứng âm thanh tổng hợp bằng WebAudio (không cần file âm thanh).
let ctx = null;
let enabled = true;
export const setSfxEnabled = (v) => { enabled = v; };

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, start, dur, { type = 'sine', gain = 0.15, slide = 0 } = {}) {
  const c = ac(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime + start);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, c.currentTime + start + dur);
  g.gain.setValueAtTime(0.0001, c.currentTime + start);
  g.gain.exponentialRampToValueAtTime(gain, c.currentTime + start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + start);
  o.stop(c.currentTime + start + dur + 0.02);
}

function noise(start, dur, { freq = 3000, q = 0.8, gain = 0.25 } = {}) {
  const c = ac(); if (!c) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(c.destination);
  src.start(c.currentTime + start);
}

export const sfx = {
  deal(i = 0) { if (enabled) noise(i * 0.07, 0.09, { freq: 2600, gain: 0.35 }); },
  flip() { if (enabled) { noise(0, 0.06, { freq: 1800, gain: 0.3 }); noise(0.05, 0.05, { freq: 3500, gain: 0.2 }); } },
  chips() {
    if (!enabled) return;
    for (let i = 0; i < 3; i++) tone(2400 + Math.random() * 900, i * 0.045, 0.05, { type: 'triangle', gain: 0.07 });
    noise(0, 0.12, { freq: 5000, q: 2, gain: 0.12 });
  },
  check() { if (enabled) { tone(180, 0, 0.08, { gain: 0.25 }); tone(170, 0.11, 0.08, { gain: 0.2 }); } },
  fold() { if (enabled) noise(0, 0.18, { freq: 900, gain: 0.25 }); },
  turn() { if (enabled) { tone(880, 0, 0.18, { gain: 0.12 }); tone(1320, 0.12, 0.28, { gain: 0.1 }); } },
  tick() { if (enabled) tone(1500, 0, 0.03, { type: 'square', gain: 0.03 }); },
  win() {
    if (!enabled) return;
    [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.35, { type: 'triangle', gain: 0.1 }));
  },
  fanfare() {
    if (!enabled) return;
    [392, 523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.4, { type: 'sawtooth', gain: 0.05 }));
    [523, 659, 784].forEach((f) => tone(f, 0.9, 1.2, { type: 'triangle', gain: 0.06 }));
  },
};
