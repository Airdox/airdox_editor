/**
 * StemRegistry – dynamic stem handling (§10).
 *
 * The engine never assumes `output[0] === vocals`. Stems are created from the
 * descriptor's `stemOrder`, and backend output files are matched either by
 * their declared output index or by their stem name. Anything unmatched is an
 * error, never a silent guess.
 */
import { StemSeparationError } from './errors';
import type { ModelDescriptor, StemDescriptor, StemId } from './types';

export interface BackendStemFile {
  /** Stem name the backend reported (file name without extension, lowercased). */
  name: string;
  filePath: string;
  /** Optional explicit output index reported by the backend. */
  outputIndex?: number;
}

export class StemRegistry {
  private readonly descriptor: ModelDescriptor;
  private readonly indexToStem: Map<number, StemId>;

  constructor(descriptor: ModelDescriptor) {
    if (!descriptor.stemOrder?.length) {
      throw new StemSeparationError('STEM_CONFIG_INVALID', `Modell ${descriptor.id} hat keine stem_order`);
    }
    this.descriptor = descriptor;
    this.indexToStem = new Map(descriptor.stemOrder.map((stem, index) => [index, stem]));
  }

  get modelId(): string {
    return this.descriptor.id;
  }

  get stemIds(): StemId[] {
    return [...this.descriptor.stemOrder];
  }

  get stemCount(): number {
    return this.descriptor.stemOrder.length;
  }

  stemAt(index: number): StemId {
    const stem = this.indexToStem.get(index);
    if (!stem) {
      throw new StemSeparationError('STEM_CONFIG_INVALID', `Output-Index ${index} ist für Modell ${this.descriptor.id} nicht definiert`, {
        stemOrder: this.descriptor.stemOrder,
      });
    }
    return stem;
  }

  indexOf(stem: StemId): number {
    const index = this.descriptor.stemOrder.indexOf(stem);
    if (index < 0) {
      throw new StemSeparationError('STEM_CONFIG_INVALID', `Stem "${stem}" wird von Modell ${this.descriptor.id} nicht geliefert`, {
        stemOrder: this.descriptor.stemOrder,
      });
    }
    return index;
  }

  displayName(stem: StemId): string {
    return this.descriptor.stemDisplayNames?.[stem] ?? stem;
  }

  /** Requests that the model actually produces every requested stem. */
  assertRequestedStemsSupported(requested: StemId[]): void {
    for (const stem of requested) this.indexOf(stem);
  }

  /**
   * Maps backend output files onto the declared stems.
   * Priority: explicit output index, then exact name, then `stem_<i>_<name>`.
   * Missing stems raise `STEM_CONFIG_INVALID` – a half delivered result is
   * never presented as complete (§17).
   */
  mapOutputs(files: BackendStemFile[], expected: StemId[]): Map<StemId, BackendStemFile> {
    const mapped = new Map<StemId, BackendStemFile>();
    const consumed = new Set<BackendStemFile>();

    for (const file of files) {
      if (typeof file.outputIndex === 'number' && this.indexToStem.has(file.outputIndex)) {
        const stem = this.indexToStem.get(file.outputIndex)!;
        if (!mapped.has(stem)) {
          mapped.set(stem, file);
          consumed.add(file);
          continue;
        }
      }
      const normalised = file.name.toLowerCase();
      const byName = this.descriptor.stemOrder.find((stem) => stem.toLowerCase() === normalised);
      if (byName && !mapped.has(byName)) {
        mapped.set(byName, file);
        consumed.add(file);
        continue;
      }
      const indexed = normalised.match(/^stem[_-]?(\d+)(?:[_-](.+))?$/);
      if (indexed) {
        const idx = Number(indexed[1]);
        if (this.indexToStem.has(idx) && !mapped.has(this.indexToStem.get(idx)!)) {
          const stem = this.indexToStem.get(idx)!;
          mapped.set(stem, file);
          consumed.add(file);
        }
      }
    }

    const missing = expected.filter((stem) => !mapped.has(stem));
    if (missing.length > 0) {
      throw new StemSeparationError(
        'STEM_CONFIG_INVALID',
        `Backend hat nicht alle erwarteten Stems geliefert. Fehlend: ${missing.join(', ')}`,
        { expected, received: files.map((f) => ({ name: f.name, outputIndex: f.outputIndex })) }
      );
    }
    const unexpected = files.filter((file) => !consumed.has(file)).map((file) => file.name);
    if (unexpected.length > 0) {
      throw new StemSeparationError(
        'STEM_CONFIG_INVALID',
        `Backend lieferte unbekannte Stems: ${unexpected.join(', ')}`,
        { stemOrder: this.descriptor.stemOrder }
      );
    }
    return mapped;
  }

  /** Creates the on-disk stem descriptors (metadata only, files come later). */
  describeStem(stem: StemId, outputIndex: number): Pick<StemDescriptor, 'id' | 'displayName' | 'outputIndex' | 'sampleRate' | 'channelCount'> {
    return {
      id: stem,
      displayName: this.displayName(stem),
      outputIndex,
      sampleRate: this.descriptor.sampleRate,
      channelCount: this.descriptor.inputChannels === 2 ? 2 : 1,
    };
  }
}
