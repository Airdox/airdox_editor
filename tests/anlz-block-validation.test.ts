/** Low-level tagged-section safety and modern three-band variant regression. */
import { parseAnlzBinary } from '../src/rekordbox/anlzParser';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function u32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}
function block(tag: string, lenHeader: number, body: number[], lenTag = 12 + body.length): number[] {
  return [...tag].map((c) => c.charCodeAt(0)).concat(u32(lenHeader), u32(lenTag), body);
}
function bytes(...parts: number[][]): ArrayBuffer {
  return Uint8Array.from(parts.flat()).buffer;
}

console.log('ANLZ TAGGED-BLOCK VALIDATION');

const unknown = block('PX01', 12, [0xaa, 0xbb, 0xcc]);
const pav6Body = [...u32(3), ...u32(2), 10, 20, 30, 40, 50, 60];
const pav6 = block('P@V6', 0x14, pav6Body);
const parsed = parseAnlzBinary(bytes(unknown, pav6));
assert(parsed.tagBlocks.length === 2, 'two sequential blocks are navigated by len_tag');
assert(parsed.unknownTags.length === 1, 'unknown FourCC stays diagnostic, not fatal');
assert(parsed.unknownTags[0].fourcc === 'PX01', 'unknown FourCC retained');
assert(parsed.unknownTags[0].offset === 0, 'unknown offset retained');
assert(parsed.unknownTags[0].lenHeader === 12 && parsed.unknownTags[0].lenTag === 15, 'unknown lengths retained big-endian');
assert(parsed.unknownTags[0].rawBytes.length === 3 && parsed.unknownTags[0].rawBytes[0] === 0xaa, 'unknown raw payload retained');
assert(parsed.waveform?.sourceTag === 'P@V6', 'P@V6 three-band preview is recognized');
assert(parsed.waveform?.length === 2, 'P@V6 entry count is big-endian');
assert(Math.abs((parsed.waveform?.lowEnergy[0] ?? 0) - 10 / 255) < 1e-6, 'P@V6 low/mid/high byte order is preserved');

const invalidHeader = parseAnlzBinary(bytes(block('BAD!', 8, [], 12)));
assert(invalidHeader.tagsFound.length === 0, 'len_header below 12 is never accepted');
assert(invalidHeader.warnings.some((warning) => warning.includes('Parser angehalten')), 'bad header is diagnosed');

const truncated = parseAnlzBinary(bytes([...'TRNC'].map((c) => c.charCodeAt(0)).concat(u32(12), u32(999))));
assert(truncated.tagsFound.length === 0, 'len_tag beyond EOF is never accepted');
assert(truncated.warnings.length === 1, 'truncated section is not a silent success');

console.log('PASS  FourCC / len_header / len_tag / bounds / unknown tags / P@V6');

// Every waveform section accepted by the normalized model is exercised using
// its documented header shape. The final PWV7 must win the source priority.
const monoPreview = (tag: 'PWAV' | 'PWV2') => block(tag, 0x14, [...u32(2), ...u32(0x10000), 0x1f, 0x0f]);
const detailed = (tag: 'PWV3' | 'PWV5', entryBytes: number, payload: number[]) =>
  block(tag, 0x18, [...u32(entryBytes), ...u32(1), ...u32(0x00960000), ...payload]);
const colorPreview = block('PWV4', 0x18, [
  ...u32(6), ...u32(1), ...u32(0),
  0, 127, 64, 127, 63, 31, // control, brightness, background, low/red, mid/green, high/blue
]);
const threeBand = (tag: 'PWV6' | 'P@V6' | 'PWV7') =>
  tag === 'PWV6' || tag === 'P@V6'
    ? block(tag, 0x14, [...u32(3), ...u32(1), 1, 2, 3])
    : block(tag, 0x18, [...u32(3), ...u32(1), ...u32(0x00960000), 4, 5, 6]);
const allWaveforms = parseAnlzBinary(bytes(
  monoPreview('PWAV'), monoPreview('PWV2'), detailed('PWV3', 1, [0x1f]), colorPreview,
  detailed('PWV5', 2, [0xe0, 0x7c]), threeBand('PWV6'), threeBand('P@V6'), threeBand('PWV7'),
  block('PVBR', 12, [1, 2, 3]),
));
for (const tag of ['PWAV', 'PWV2', 'PWV3', 'PWV4', 'PWV5', 'PWV6', 'P@V6', 'PWV7', 'PVBR']) {
  assert(allWaveforms.tagsFound.includes(tag), `${tag} is recognized in tagged sequence`);
}
assert(allWaveforms.waveformVariants.length === 8, 'all documented waveform variants decode');
assert(allWaveforms.waveform?.sourceTag === 'PWV7', 'PWV7 wins waveform priority');
assert(allWaveforms.unknownTags.length === 0, 'known PVBR is not reported as unknown');
const onlyPwv4 = parseAnlzBinary(bytes(colorPreview));
assert(Math.abs((onlyPwv4.waveform?.lowEnergy[0] ?? 0) - 1) < 1e-6, 'PWV4 red channel is low energy');
assert(Math.abs((onlyPwv4.waveform?.midEnergy[0] ?? 0) - 63 / 127) < 1e-6, 'PWV4 green channel is mid energy');
assert(Math.abs((onlyPwv4.waveform?.highEnergy[0] ?? 0) - 31 / 127) < 1e-6, 'PWV4 blue channel is high energy');
console.log('PASS  PWAV/PWV2/PWV3/PWV4/PWV5/PWV6/P@V6/PWV7/PVBR');
