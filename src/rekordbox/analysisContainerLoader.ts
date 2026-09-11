/**
 * Deterministic loader for the Rekordbox ANLZ container set addressed by
 * master.db. It reads only the resolved file and same-directory extension
 * siblings; it never searches the filesystem or derives replacement data.
 */

import { deriveSiblingExtension } from './analysisResolver';
import {
  AnlzExtractionResult,
  mergeAnlzExtractions,
  parseAnlzBinary,
} from './databaseExtractor';

export interface AnlzFilePayload {
  data: ArrayBuffer | Uint8Array;
  size?: number;
}

export interface LoadedAnlzContainer {
  path: string;
  size?: number;
  extraction: AnlzExtractionResult;
}

export interface LoadedAnlzContainerSet {
  resolvedPath: string;
  primary: LoadedAnlzContainer;
  datExtSibling?: LoadedAnlzContainer;
  twoExSibling?: LoadedAnlzContainer;
  twoExError?: string;
  extraction: AnlzExtractionResult;
}

export type ReadAnlzFile = (filePath: string) => Promise<AnlzFilePayload>;

function exactArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

async function readContainer(path: string, readFile: ReadAnlzFile): Promise<LoadedAnlzContainer> {
  const source = await readFile(path);
  return {
    path,
    size: source.size,
    extraction: parseAnlzBinary(exactArrayBuffer(source.data)),
  };
}

/**
 * Loads and merges the DB-addressed ANLZ container family.
 *
 * The DAT/EXT pair is mandatory because its members jointly carry the normal
 * Rekordbox beatgrid, cues, phrases, and waveform variants. The 2EX sibling
 * is optional because older Rekordbox analyses may not contain it. Every
 * sibling path is an extension-only rewrite in the same directory.
 */
export async function loadAnlzContainerSet(
  resolvedPath: string,
  readFile: ReadAnlzFile
): Promise<LoadedAnlzContainerSet> {
  const primary = await readContainer(resolvedPath, readFile);
  let extraction = primary.extraction;

  const datExtPath =
    deriveSiblingExtension(resolvedPath, 'EXT') ??
    deriveSiblingExtension(resolvedPath, 'DAT');
  let datExtSibling: LoadedAnlzContainer | undefined;

  if (datExtPath) {
    try {
      datExtSibling = await readContainer(datExtPath, readFile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[ANLZ Pipelinefehler] Rekordbox-Schwesterncontainer „${datExtPath}“ ist nicht lesbar: ${reason}`
      );
    }

    // DAT remains the positional primary because it owns the PQTZ grid;
    // EXT remains secondary because its PCO2/PSSI data takes priority.
    extraction = /\.ext$/i.test(datExtPath)
      ? mergeAnlzExtractions(extraction, datExtSibling.extraction)
      : mergeAnlzExtractions(datExtSibling.extraction, extraction);
  }

  const twoExPath = deriveSiblingExtension(resolvedPath, '2EX');
  let twoExSibling: LoadedAnlzContainer | undefined;
  let twoExError: string | undefined;
  if (twoExPath) {
    try {
      twoExSibling = await readContainer(twoExPath, readFile);
      extraction = mergeAnlzExtractions(extraction, twoExSibling.extraction);
    } catch (error) {
      twoExError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    resolvedPath,
    primary,
    datExtSibling,
    twoExSibling,
    twoExError,
    extraction,
  };
}
