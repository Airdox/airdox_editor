/**
 * @license
 * Minimal Web Audio stand-in for tests (test-only file).
 *
 * jsdom has no Web Audio API. The audio engine only needs a small, spec-shaped
 * slice of it: buffers with real Float32Array channels, a graph of no-op nodes,
 * and a clock the test can advance (that is what makes the playback-position and
 * loop maths verifiable instead of "just executed"). Nothing here computes audio
 * effects — the engine's own code does all of it on top of these primitives.
 */

export interface FakeAudioBuffer {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  duration: number;
  getChannelData(ch: number): Float32Array;
  copyToChannel?(src: Float32Array, channelNumber: number, startInChannel?: number): void;
}

export function createFakeAudioBuffer(
  channels: number,
  length: number,
  sampleRate: number,
  fill?: (ch: number, data: Float32Array) => void
): FakeAudioBuffer {
  const data: Float32Array[] = [];
  for (let ch = 0; ch < Math.max(1, channels); ch++) {
    const arr = new Float32Array(length);
    if (fill) fill(ch, arr);
    data.push(arr);
  }
  return {
    sampleRate,
    numberOfChannels: Math.max(1, channels),
    length,
    duration: length / sampleRate,
    getChannelData: (ch: number) => data[Math.min(Math.max(0, ch), data.length - 1)],
    copyToChannel: (src: Float32Array, ch: number, start = 0) => {
      data[Math.min(ch, data.length - 1)].set(src, start);
    },
  };
}

/** Buffer whose channel 0 encodes its own sample index (×scale) — easy to assert on. */
export function createIndexedBuffer(seconds: number, sampleRate = 1000, scale = 1, channels = 2): FakeAudioBuffer {
  const length = Math.round(seconds * sampleRate);
  return createFakeAudioBuffer(channels, length, sampleRate, (ch, data) => {
    for (let i = 0; i < length; i++) data[i] = ((i % 97) / 97) * scale * (ch === 0 ? 1 : 0.5);
  });
}

class FakeParam {
  value = 1;
  setValueAtTime(v: number, _t: number) {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, _t: number) {
    this.value = v;
    return this;
  }
  cancelScheduledValues(_t: number) {
    return this;
  }
}

class FakeNode {
  ctx: FakeAudioContext;
  gain = new FakeParam();
  fftSize = 64;
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate = new FakeParam();
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  startedOffset = 0;
  stopped = false;
  connections: FakeNode[] = [];

  constructor(ctx: FakeAudioContext) {
    this.ctx = ctx;
  }
  connect(dest: unknown, output?: number, _input?: number) {
    void output;
    if (dest) this.connections.push(dest as FakeNode);
    return dest;
  }
  disconnect() {
    this.connections.length = 0;
  }
  start(when = 0, offset = 0) {
    void when;
    this.startedAt = this.ctx.currentTime;
    this.startedOffset = offset;
    this.stopped = false;
  }
  stop(_when?: number) {
    if (this.startedAt !== null && !this.stopped) {
      this.stopped = true;
      this.onended?.();
    }
  }
  getByteTimeDomainData(arr: Uint8Array) {
    // A flat 128 means "silence" for the meter; tests that want movement write it.
    arr.fill(this.ctx.meterLevel);
  }
  getFloatTimeDomainData(arr: Float32Array) {
    arr.fill(0);
  }
  getByteFrequencyData(arr: Uint8Array) {
    arr.fill(0);
  }
}

export class FakeAudioContext {
  currentTime = 0;
  sampleRate = 44100;
  state: 'running' | 'suspended' = 'running';
  destination: unknown = {};
  /** Meter level used by the fake analyser (128 = silence). */
  meterLevel = 128;
  /** What decodeAudioData resolves with (default: one second of stereo). */
  decodeResult: FakeAudioBuffer | null = null;
  createdBuffers: FakeAudioBuffer[] = [];
  sources: FakeNode[] = [];
  decodeCalls = 0;

  createBuffer(channels: number, length: number, sampleRate: number) {
    const buffer = createFakeAudioBuffer(channels, length, sampleRate);
    this.createdBuffers.push(buffer);
    return buffer as unknown as AudioBuffer;
  }
  createGain() {
    return new FakeNode(this) as unknown as GainNode;
  }
  createAnalyser() {
    return new FakeNode(this) as unknown as AnalyserNode;
  }
  createChannelSplitter() {
    return new FakeNode(this) as unknown as ChannelSplitterNode;
  }
  createBufferSource() {
    const node = new FakeNode(this);
    this.sources.push(node);
    return node as unknown as AudioBufferSourceNode;
  }
  createBiquadFilter() {
    return new FakeNode(this) as unknown as BiquadFilterNode;
  }
  createStereoPanner() {
    return new FakeNode(this) as unknown as StereoPannerNode;
  }
  createWaveShaper() {
    return new FakeNode(this) as unknown as WaveShaperNode;
  }
  createDynamicsCompressor() {
    return new FakeNode(this) as unknown as DynamicsCompressorNode;
  }
  createDelay() {
    const node = new FakeNode(this);
    (node as unknown as { delayTime: FakeParam }).delayTime = new FakeParam();
    return node as unknown as DelayNode;
  }
  createConvolver() {
    return new FakeNode(this) as unknown as ConvolverNode;
  }
  createPeriodicWave() {
    return {} as PeriodicWave;
  }
  createOscillator() {
    return new FakeNode(this) as unknown as OscillatorNode;
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  decodeAudioData(_data: ArrayBuffer): Promise<FakeAudioBuffer> {
    this.decodeCalls += 1;
    // A test supplies the decoded buffer it wants the app to see; without one the
    // default is a one-second stereo buffer so that import flows can run at all.
    return Promise.resolve(this.decodeResult ?? createIndexedBuffer(1, this.sampleRate));
  }
  /** Advances the fake clock (playback position math depends on it). */
  advance(seconds: number) {
    this.currentTime += seconds;
  }
}

/**
 * Installs the fake on the given window (idempotent) and returns it, so tests can
 * drive the clock. `window.AudioContext` is what `audioEngine.init()` reads.
 */
export function installFakeWebAudio(target: Window & typeof globalThis = window): FakeAudioContext {
  const ctor = function FakeAudioContextCtor() {
    return new FakeAudioContext();
  } as unknown as { new (): AudioContext } & { instance?: FakeAudioContext };
  // A single shared instance: the engine caches its context, meters and tests
  // must observe the same clock.
  const shared = new FakeAudioContext();
  const Shared = function SharedContext() {
    return shared;
  } as unknown as { new (): AudioContext };
  void ctor;
  (target as unknown as { AudioContext: unknown }).AudioContext = Shared;
  (target as unknown as { webkitAudioContext: unknown }).webkitAudioContext = Shared;
  return shared;
}
