import { analyzeAudioBuffer } from '../src/waveform/analyzer';
import { DataOrigin } from '../src/types/rekordbox';

const sampleRate = Number(process.env.AIRDOX_BENCH_SAMPLE_RATE) || 48_000;
const channelsCount = Number(process.env.AIRDOX_BENCH_CHANNELS) || 2;
const requestedDurations = process.argv.slice(2).map(Number).filter((value) => Number.isFinite(value) && value > 0);
const durations = requestedDurations.length > 0 ? requestedDurations : [30, 300];

function makeBuffer(durationSeconds: number) {
  const length = Math.floor(sampleRate * durationSeconds);
  const channels = Array.from({ length: channelsCount }, (_, channel) => {
    const samples = new Float32Array(length);
    const frequency = channel === 0 ? 110 : 173;
    for (let index = 0; index < length; index++) {
      samples[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.4;
    }
    return samples;
  });

  return {
    sampleRate,
    length,
    duration: length / sampleRate,
    numberOfChannels: channelsCount,
    getChannelData(channel: number) {
      const samples = channels[channel];
      if (!samples) throw new RangeError(`Channel ${channel} does not exist`);
      return samples;
    },
  } as unknown as AudioBuffer;
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rssMiB: +(usage.rss / 1024 / 1024).toFixed(1),
    heapUsedMiB: +(usage.heapUsed / 1024 / 1024).toFixed(1),
    arrayBuffersMiB: +(usage.arrayBuffers / 1024 / 1024).toFixed(1),
  };
}

console.log(`Audioanalyse-Benchmark – Node ${process.version}, ${sampleRate} Hz, ${channelsCount} Kanal/Kanäle`);
console.log('Messung umfasst nur analyzeAudioBuffer; Buffer-Erzeugung/Warm-up werden nicht mitgezählt.');

for (const durationSeconds of durations) {
  const buffer = makeBuffer(durationSeconds);
  analyzeAudioBuffer(buffer, DataOrigin.LOCAL_ANALYSIS); // JIT warm-up
  const before = memorySnapshot();
  const startedAt = performance.now();
  const analysis = analyzeAudioBuffer(buffer, DataOrigin.LOCAL_ANALYSIS);
  const elapsedMs = performance.now() - startedAt;
  const after = memorySnapshot();
  const samples = buffer.length * buffer.numberOfChannels;

  console.log(JSON.stringify({
    durationSeconds: buffer.duration,
    channels: buffer.numberOfChannels,
    samples,
    buckets: analysis.length,
    elapsedMs: +elapsedMs.toFixed(1),
    samplesPerSecond: Math.round(samples / (elapsedMs / 1000)),
    memoryBeforeMiB: before,
    memoryAfterMiB: after,
  }));
}
