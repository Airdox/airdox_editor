import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StemCenter, processingPercent } from '../src/components/zones/StemCenter';
import { DEFAULT_STEMS_MIXER_STATE } from '../src/audio/stemEngine';

const noop = () => {};
const props: React.ComponentProps<typeof StemCenter> = {
  phase: 'PROCESSING', configOpen: false, onOpenConfig: noop, onCloseConfig: noop,
  modelPickerOpen: false, onOpenModelPicker: noop, onCloseModelPicker: noop,
  activeModelLabel: 'SCNet', modelOptions: [], selectedArchitectureId: 'auto', onSelectArchitecture: noop,
  qualityMode: 'fast', onQualityModeChange: noop, targetMode: 'local', onTargetModeChange: noop,
  remoteConfigured: true, remoteStatus: { jobs: [{ jobId: 'remote-other', status: 'PENDING' }], label: 'Drive' } as any,
  onOpenRemoteSetup: noop, onStartJob: noop, missingModel: null, onInstallModel: noop,
  progress: { percent: 17, phaseText: 'Lokale Inferenz läuft', processedSeconds: 1, totalSeconds: 10 },
  onCancelSeparation: noop,
  deckProps: { stems: null, mixerState: DEFAULT_STEMS_MIXER_STATE, onToggleStemMute: noop,
    onToggleStemSolo: noop, onStemVolumeChange: noop, onExtractStemToClip: noop,
    onSetAcapella: noop, onSetInstrumental: noop, onResetStems: noop },
};
const local = renderToStaticMarkup(<StemCenter {...props} />);
assert.match(local, /Lokale Inferenz läuft/);
assert.match(local, /Fortschritt: 17%/);
assert.doesNotMatch(local, /Wartet auf externen Rechner/);
assert.match(local, /data-stem-action="cancel-job"/);
const remote = renderToStaticMarkup(<StemCenter {...props} targetMode="remote" />);
assert.match(remote, /Wartet auf externen Rechner/);
assert.equal(processingPercent({ ...props.progress!, percent: Number.NaN }, undefined), 0);
assert.equal(processingPercent({ ...props.progress!, percent: Number.POSITIVE_INFINITY }, undefined), 0);
assert.equal(processingPercent({ ...props.progress!, percent: 101 }, undefined), 100);
console.log('StemCenter local/remote progress isolation, cancellation visibility, finite percent passed.');

const unreachableStatus = { ...props.remoteStatus!, reachable: false };
const localConfig = renderToStaticMarkup(<StemCenter {...props} phase="CONFIGURE" remoteStatus={unreachableStatus} />);
assert.doesNotMatch(localConfig, /ist gerade nicht erreichbar/, 'local setup must not show an unrelated remote outage');
const remoteConfig = renderToStaticMarkup(<StemCenter {...props} phase="CONFIGURE" targetMode="remote" remoteStatus={unreachableStatus} />);
assert.match(remoteConfig, /ist gerade nicht erreichbar/, 'remote setup keeps its connection warning');
console.log('StemCenter connection warning follows the selected processing target.');
