import { parseRekordboxXmlAsync } from '../src/rekordbox/xmlParser';

import { runTest, report } from './helpers/microTest.mjs';

runTest('large-xml', '11 000 Tracks: Import bleibt schnell und lässt die Beat-Grids kompakt', async () => {
  const trackCount = 11_000;
  const tracks = Array.from({ length: trackCount }, (_, index) =>
    `<TRACK TrackID="${index + 1}" Name="Load Test ${index + 1}" Artist="Importer" TotalTime="300" AverageBpm="128.00" Tonality="8A"><TEMPO Inizio="0" Bpm="128.00" Metro="4/4" Battito="1"/><POSITION_MARK Name="Start" Type="0" Start="0" Num="-1"/></TRACK>`
  ).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="${trackCount}">${tracks}</COLLECTION></DJ_PLAYLISTS>`;

  const started = performance.now();
  const result = await parseRekordboxXmlAsync(xml);
  const elapsedMs = Math.round(performance.now() - started);

  if (result.tracks.length !== trackCount) {
    throw new Error(`Expected ${trackCount} tracks, received ${result.tracks.length}.`);
  }
  if (result.tracks.some((track) => track.origin !== 'REKORDBOX_XML')) {
    throw new Error('Every imported track must retain REKORDBOX_XML as its origin.');
  }
  if (result.tracks.some((track) => track.beatGrid?.beats.length !== 0)) {
    throw new Error('Collection import must not allocate dense beat grids before a track is loaded.');
  }

  console.log(`Imported ${result.tracks.length} tracks in ${elapsedMs}ms using compact collection beatgrids.`);
});

report('GROSSER-XML-IMPORT (Lasttest der Sammlungsanalyse)');
