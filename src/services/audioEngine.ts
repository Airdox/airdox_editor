import { DJTrack } from "../types";

class DeckAudioNode {
  ctx: AudioContext;
  deckId: 1 | 2;
  isPlaying = false;
  bpm = 126;
  timerId: number | null = null;
  step = 0;

  // Audio Nodes
  eqLowNode: BiquadFilterNode;
  eqMidNode: BiquadFilterNode;
  eqHighNode: BiquadFilterNode;
  filterNode: BiquadFilterNode;
  volumeNode: GainNode;
  faderGainNode: GainNode;
  analyserNode: AnalyserNode;

  // Root frequency for the track's key
  baseFreq = 130.81; // C3 default

  constructor(ctx: AudioContext, deckId: 1 | 2, masterIn: GainNode) {
    this.ctx = ctx;
    this.deckId = deckId;

    // Filters
    this.eqLowNode = ctx.createBiquadFilter();
    this.eqLowNode.type = "lowshelf";
    this.eqLowNode.frequency.value = 250;
    this.eqLowNode.gain.value = 0;

    this.eqMidNode = ctx.createBiquadFilter();
    this.eqMidNode.type = "peaking";
    this.eqMidNode.frequency.value = 1000;
    this.eqMidNode.gain.value = 0;

    this.eqHighNode = ctx.createBiquadFilter();
    this.eqHighNode.type = "highshelf";
    this.eqHighNode.frequency.value = 4000;
    this.eqHighNode.gain.value = 0;

    this.filterNode = ctx.createBiquadFilter();
    this.filterNode.type = "allpass"; // neutral by default

    this.volumeNode = ctx.createGain();
    this.volumeNode.gain.value = 0.85;

    this.faderGainNode = ctx.createGain();
    this.faderGainNode.gain.value = 1.0;

    this.analyserNode = ctx.createAnalyser();
    this.analyserNode.fftSize = 64;

    // Chain: Sound -> Low -> Mid -> High -> Filter -> Volume -> CrossfaderGain -> MasterIn & Analyser
    this.eqLowNode.connect(this.eqMidNode);
    this.eqMidNode.connect(this.eqHighNode);
    this.eqHighNode.connect(this.filterNode);
    this.filterNode.connect(this.volumeNode);
    this.volumeNode.connect(this.faderGainNode);
    this.faderGainNode.connect(masterIn);
    this.faderGainNode.connect(this.analyserNode);
  }

  setTrack(track: DJTrack | null) {
    if (!track) return;
    this.bpm = track.bpm;
    // Map Camelot key to a root pitch
    const keyMap: Record<string, number> = {
      "8A": 110.0, // A2 (Am)
      "9A": 82.41, // E2 (Em)
      "7A": 73.42, // D2 (Dm)
      "4A": 87.31, // F2 (Fm)
      "4B": 103.83, // Ab2 (Ab)
      "8B": 130.81, // C3 (C)
      "11A": 92.5, // F#2 (F#m)
    };
    this.baseFreq = keyMap[track.camelotKey] || 110.0;
  }

  setEQ(low: number, mid: number, high: number) {
    // Input 0..1, center 0.5 -> -24dB to +6dB
    const mapGain = (v: number) => (v < 0.5 ? (v - 0.5) * 48 : (v - 0.5) * 12);
    this.eqLowNode.gain.setTargetAtTime(mapGain(low), this.ctx.currentTime, 0.05);
    this.eqMidNode.gain.setTargetAtTime(mapGain(mid), this.ctx.currentTime, 0.05);
    this.eqHighNode.gain.setTargetAtTime(mapGain(high), this.ctx.currentTime, 0.05);
  }

  setFilter(val: number) {
    // val is -1 (Full LPF) to 0 (neutral) to +1 (Full HPF)
    if (Math.abs(val) < 0.05) {
      this.filterNode.type = "allpass";
    } else if (val < 0) {
      this.filterNode.type = "lowpass";
      // sweep 20000Hz down to 200Hz
      const freq = 20000 * Math.pow(0.01, -val);
      this.filterNode.frequency.setTargetAtTime(Math.max(120, freq), this.ctx.currentTime, 0.05);
    } else {
      this.filterNode.type = "highpass";
      // sweep 20Hz up to 8000Hz
      const freq = 20 * Math.pow(400, val);
      this.filterNode.frequency.setTargetAtTime(Math.min(12000, freq), this.ctx.currentTime, 0.05);
    }
  }

  setVolume(vol: number) {
    this.volumeNode.gain.setTargetAtTime(Math.max(0, Math.min(1, vol)), this.ctx.currentTime, 0.05);
  }

  setCrossfaderGain(gain: number) {
    this.faderGainNode.gain.setTargetAtTime(Math.max(0, Math.min(1, gain)), this.ctx.currentTime, 0.05);
  }

  play() {
    if (this.isPlaying) return;
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    this.isPlaying = true;
    this.scheduleBeat();
  }

  pause() {
    this.isPlaying = false;
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private triggerKick(time: number) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.setValueAtTime(140, time);
    osc.frequency.exponentialRampToValueAtTime(38, time + 0.12);
    gain.gain.setValueAtTime(0.9, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
    osc.connect(gain);
    gain.connect(this.eqLowNode);
    osc.start(time);
    osc.stop(time + 0.28);
  }

  private triggerHiHat(time: number, isOpen = false) {
    // Noise burst
    const bufferSize = this.ctx.sampleRate * (isOpen ? 0.2 : 0.04);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 7500;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(isOpen ? 0.3 : 0.18, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + (isOpen ? 0.18 : 0.035));

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.eqLowNode);
    noise.start(time);
    noise.stop(time + (isOpen ? 0.2 : 0.04));
  }

  private triggerBass(time: number) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(this.baseFreq, time);
    gain.gain.setValueAtTime(0.35, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.2);
    osc.connect(gain);
    gain.connect(this.eqLowNode);
    osc.start(time);
    osc.stop(time + 0.22);
  }

  private scheduleBeat() {
    if (!this.isPlaying) return;
    const interval = 60 / this.bpm / 4; // 16th notes
    const now = this.ctx.currentTime;

    // 16-step beat pattern
    const isQuarter = this.step % 4 === 0;
    const isOffbeat = this.step % 4 === 2;

    // 4-on-the-floor kick
    if (isQuarter) {
      this.triggerKick(now);
    }
    // Offbeat hi-hat
    if (isOffbeat) {
      this.triggerHiHat(now, true);
    } else {
      this.triggerHiHat(now, false);
    }
    // Bass on offbeats
    if (this.step % 2 === 1) {
      this.triggerBass(now);
    }

    this.step = (this.step + 1) % 16;
    this.timerId = window.setTimeout(() => {
      this.scheduleBeat();
    }, interval * 1000);
  }

  getVUMeter(): number {
    if (!this.isPlaying) return 0;
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    return Math.min(1, (sum / data.length / 255) * 1.5);
  }
}

class DJAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  public deck1: DeckAudioNode | null = null;
  public deck2: DeckAudioNode | null = null;

  init() {
    if (this.ctx) return;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;
    this.masterGain.connect(this.ctx.destination);

    this.deck1 = new DeckAudioNode(this.ctx, 1, this.masterGain);
    this.deck2 = new DeckAudioNode(this.ctx, 2, this.masterGain);
  }

  ensureContext() {
    if (!this.ctx) {
      this.init();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  setCrossfader(val: number) {
    // val is -1 (all Deck 1) to 1 (all Deck 2)
    this.ensureContext();
    if (!this.deck1 || !this.deck2) return;
    // Equal power curve
    const x = (val + 1) / 2; // 0 to 1
    const gain1 = Math.cos((x * Math.PI) / 2);
    const gain2 = Math.sin((x * Math.PI) / 2);
    this.deck1.setCrossfaderGain(gain1);
    this.deck2.setCrossfaderGain(gain2);
  }

  setMasterVolume(vol: number) {
    this.ensureContext();
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.05);
    }
  }
}

export const audioEngine = new DJAudioEngine();
