// ── soprano voice data ───────────────────────────────────────────────────────
const soprano = {
  pitches: [184.997, 261.626, 369.994, 523.251, 739.989, 1046.502, 1479.978],
  fmt1:    [175, 262, 392, 523, 784, 1046, 1568],
  fmt2:    [350, 524, 784, 950, 1568, 2092, 3136],
  fmt3:    [2800, 2700, 2500, 2450, 2400, 2350, 4500],
  a1:      [.4, .4, .8, .8, .8, .8, .8],
  a2:      [.8, .8, .4, .2, .1, .1,  0],
  a3:      [.15, .15, .15, .15, .15, .1, .1],
  I1:      [.1, .1, .1, .1, 0, 0, 0],
  I2:      [.5, .1, .1, .1, 0, 0, 0],
  I3:      [1.6, 1.6, 1.6, 1.6, 1.6, 1.5, 1],
};

const SMOOTH = 0.08;

// ── linear interpolation through the soprano table ───────────────────────────
function lookup(table, frequency) {
  const p = soprano.pitches;
  const last = p.length - 1;
  if (frequency <= p[0])    return table[0];
  if (frequency >= p[last]) return table[last];
  for (let i = 0; i < last; i++) {
    if (frequency <= p[i + 1]) {
      const t = (frequency - p[i]) / (p[i + 1] - p[i]);
      return table[i] + t * (table[i + 1] - table[i]);
    }
  }
}

// ── build one FM voice, returns { update(tone,amp,vibratoOn), setReverb, setPan, dispose } ─
function buildVoice(masterGain) {
  // signal path: gainOut → panner → reverb (wet knob handles dry/wet) → masterGain
  const gainOut = new Tone.Gain(0);
  const panner  = new Tone.Panner(0);
  const reverb  = new Tone.Reverb({ decay: 2, wet: 0 });

  gainOut.connect(panner);
  panner.connect(reverb);
  reverb.connect(masterGain);

  // FM oscillators
  let tone = 195.9;
  const gain1 = new Tone.Gain(0).connect(gainOut);
  const gain2 = new Tone.Gain(0).connect(gainOut);
  const gain3 = new Tone.Gain(0).connect(gainOut);
  const c1 = new Tone.Oscillator(tone).connect(gain1);
  const c2 = new Tone.Oscillator(tone).connect(gain2);
  const c3 = new Tone.Oscillator(tone).connect(gain3);
  const depth1 = new Tone.Gain(0).connect(c1.frequency);
  const depth2 = new Tone.Gain(0).connect(c2.frequency);
  const depth3 = new Tone.Gain(0).connect(c3.frequency);
  const m = new Tone.Oscillator(tone);
  m.connect(depth1); m.connect(depth2); m.connect(depth3);

  // vibrato
  const vibrato      = new Tone.LFO(5, -1, 1);
  const periodicDepth = new Tone.Gain(0);
  vibrato.connect(periodicDepth);
  for (const osc of [m, c1, c2, c3]) periodicDepth.connect(osc.detune);

  const now = Tone.now();
  vibrato.start(now); m.start(now); c1.start(now); c2.start(now); c3.start(now);
  reverb.generate();

  function read(table) { return lookup(table, tone); }

  function updateVibrato(vibratoOn, vibratoStrength = 1) {
    const low  = soprano.pitches[0];
    const high = soprano.pitches[soprano.pitches.length - 1];
    const frac = Math.max(0, Math.min(1, (tone - low) / (high - low)));
    const curved = (Math.exp(frac) - 1) / (Math.E - 1);
    vibrato.frequency.rampTo(5 + 1.5 * curved, SMOOTH);
    const percent = 0.2 * Math.log2(tone);
    const cents   = 1200 * Math.log2(1 + percent / 100);
    periodicDepth.gain.rampTo(cents * (vibratoOn ? vibratoStrength : 0), SMOOTH);
  }

  function update(newTone, amp, vibratoOn) {
    tone = newTone;
    updateVibrato(vibratoOn);
    m.frequency.rampTo(tone, SMOOTH);
    c1.frequency.rampTo(Math.round(read(soprano.fmt1) / tone) * tone, SMOOTH);
    c2.frequency.rampTo(Math.round(read(soprano.fmt2) / tone) * tone, SMOOTH);
    c3.frequency.rampTo(Math.round(read(soprano.fmt3) / tone) * tone, SMOOTH);
    gain1.gain.rampTo(amp ** 0.5 * read(soprano.a1), SMOOTH);
    gain2.gain.rampTo(amp ** 1.5 * read(soprano.a2), SMOOTH);
    gain3.gain.rampTo(amp ** 2   * read(soprano.a3), SMOOTH);
    depth1.gain.rampTo(read(soprano.I1) * tone, SMOOTH);
    depth2.gain.rampTo(read(soprano.I2) * tone, SMOOTH);
    depth3.gain.rampTo(read(soprano.I3) * tone, SMOOTH);
  }

  function setReverb(wet) {
    reverb.wet.rampTo(wet, SMOOTH);
  }

  function setPan(pan) { panner.pan.rampTo(pan, SMOOTH); }

  function setOutputGain(g) { gainOut.gain.rampTo(g, SMOOTH); }

  function dispose() {
    for (const node of [
      m, c1, c2, c3, gain1, gain2, gain3,
      depth1, depth2, depth3, vibrato, periodicDepth,
      gainOut, panner, reverb,
    ]) node.dispose();
  }

  return { update, setReverb, setPan, setOutputGain, dispose };
}

// ── app state ────────────────────────────────────────────────────────────────
let socket;
let mySlot    = null;
let lobbyCode = null;
let inGame    = false;

// voices[slot] = voice object built by buildVoice()
const voices = {};
const masterGain = new Tone.Gain(0.25).toDestination();

// ── p5 UI ─────────────────────────────────────────────────────────────────────
function setup() {
  noCanvas();
  Tone.start();

  socket = io();

  // ── lobby screen ──────────────────────────────────────────────
  const lobbyDiv = createDiv();
  lobbyDiv.id('lobby-screen');

  createP('Pitch (pre-game)').parent(lobbyDiv);
  const pitchSlider = createSlider(184.997, 1479.978, 195.9).parent(lobbyDiv);
  const pitchReadout = createSpan('195.9 Hz').parent(lobbyDiv);

  createP('Vibrato').parent(lobbyDiv);
  const vibratoBox = createCheckbox('', true).parent(lobbyDiv);

  const createBtn = createButton('Create Lobby').parent(lobbyDiv);
  createP('— or —').parent(lobbyDiv);
  const codeInput  = createInput('').parent(lobbyDiv);
  codeInput.attribute('placeholder', 'Enter code');
  const joinBtn   = createButton('Join Lobby').parent(lobbyDiv);

  createP('').parent(lobbyDiv);
  const statusEl = createP('').parent(lobbyDiv);
  const slotsEl  = createP('').parent(lobbyDiv);
  const readyBtn  = createButton('Ready').parent(lobbyDiv);
  readyBtn.hide();

  // ── game screen ────────────────────────────────────────────────
  const gameDiv = createDiv().id('game-screen');
  gameDiv.hide();

  createP('Amplitude').parent(gameDiv);
  const ampSlider  = createSlider(0, 1, 0.5, 0.01).parent(gameDiv);
  createP('Reverb').parent(gameDiv);
  const reverbSlider = createSlider(0, 1, 0, 0.01).parent(gameDiv);
  createP('Pan').parent(gameDiv);
  const panSlider  = createSlider(-1, 1, 0, 0.01).parent(gameDiv);

  // ── helpers ────────────────────────────────────────────────────
  function currentSettings() {
    return { pitch: Number(pitchSlider.value()), vibrato: vibratoBox.checked() };
  }

  function renderSlots(players) {
    const labels = Object.entries(players).map(([id, p]) => {
      const mark = p.ready ? '✔' : '○';
      return `P${p.slot + 1}[${mark}]`;
    }).join('  ');
    slotsEl.html(labels);
  }

  function applyGameState(players, myId) {
    const count = Object.keys(players).length;
    const share = count > 0 ? 1 / count : 1;

    for (const [id, p] of Object.entries(players)) {
      const slot = p.slot;

      // create voice if first time we see this slot
      if (!voices[slot]) {
        voices[slot] = buildVoice(masterGain);
      }
      const v = voices[slot];

      // set the voice's share of the master gain
      v.setOutputGain(share);

      if (id === myId) {
        // local voice driven by local sliders (already updated via input events)
        v.update(p.pitch, p.amplitude, p.vibrato);
        v.setReverb(p.reverb);
        v.setPan(p.pan);
      } else {
        // remote voice – match their broadcast state
        v.update(p.pitch, p.amplitude, p.vibrato);
        v.setReverb(p.reverb);
        v.setPan(p.pan);
      }
    }

    // dispose voices for slots that are no longer in the lobby
    const activeSlots = new Set(Object.values(players).map(p => p.slot));
    for (const slot of Object.keys(voices)) {
      if (!activeSlots.has(Number(slot))) {
        voices[slot].dispose();
        delete voices[slot];
      }
    }
  }

  // ── socket events ──────────────────────────────────────────────
  socket.on('lobby:update', ({ players }) => {
    renderSlots(players);
    const mine = Object.values(players).find(p => p.slot === mySlot);
    if (mine) {
      readyBtn.html(mine.ready ? 'Unready' : 'Ready');
      readyBtn.show();
    }
  });

  socket.on('game:start', ({ players }) => {
    inGame = true;
    select('#lobby-screen').hide();
    gameDiv.show();
    applyGameState(players, socket.id);
  });

  socket.on('game:update', ({ players }) => {
    if (!inGame) return;
    applyGameState(players, socket.id);
  });

  // ── button handlers ────────────────────────────────────────────
  createBtn.mousePressed(() => {
    if (lobbyCode) return;
    socket.emit('lobby:create', currentSettings(), (res) => {
      if (!res.ok) return;
      mySlot    = res.slot;
      lobbyCode = res.code;
      statusEl.html(`Lobby code: <strong>${res.code}</strong>  (you are P${res.slot + 1})`);
    });
  });

  joinBtn.mousePressed(() => {
    const code = codeInput.value().trim();
    if (!code || lobbyCode) return;
    socket.emit('lobby:join', code, currentSettings(), (res) => {
      if (!res.ok) return statusEl.html(`Error: ${res.reason}`);
      mySlot    = res.slot;
      lobbyCode = res.code;
      statusEl.html(`Joined lobby <strong>${res.code}</strong> as P${res.slot + 1}`);
    });
  });

  readyBtn.mousePressed(() => {
    const mine = voices[mySlot];
    const isReady = readyBtn.html() === 'Unready'; // currently ready → toggling off
    socket.emit('lobby:ready', !isReady);
  });

  // settings sliders update server while in lobby
  pitchSlider.input(() => {
    pitchReadout.html(Number(pitchSlider.value()).toFixed(1) + ' Hz');
    if (!lobbyCode || inGame) return;
    socket.emit('lobby:settings', currentSettings());
  });
  vibratoBox.changed(() => {
    if (!lobbyCode || inGame) return;
    socket.emit('lobby:settings', currentSettings());
  });

  // in-game sliders
  function emitGameParams() {
    if (!inGame) return;
    socket.emit('game:params', {
      amplitude: Number(ampSlider.value()),
      reverb:    Number(reverbSlider.value()),
      pan:       Number(panSlider.value()),
    });
  }
  ampSlider.input(emitGameParams);
  reverbSlider.input(emitGameParams);
  panSlider.input(emitGameParams);
}