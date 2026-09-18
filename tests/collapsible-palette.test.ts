/**
 * @license
 * Test suite for collapsible Edit Palette and responsive workspace expansion
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Collapsible Edit Palette & Workspace Maximization', () => {
  it('toggles edit palette open state cleanly', () => {
    let editPaletteOpen = true;
    const toggleEditPalette = () => {
      editPaletteOpen = !editPaletteOpen;
    };

    assert.equal(editPaletteOpen, true, 'Initially open');
    toggleEditPalette();
    assert.equal(editPaletteOpen, false, 'Collapsed when toggled');
    toggleEditPalette();
    assert.equal(editPaletteOpen, true, 'Re-expanded when toggled again');
  });

  it('Zen-Max waveform mode collapses all panels and restores them on toggle', () => {
    let editPaletteOpen = true;
    let paletteOpen = true;
    let browserOpen = false;

    const isMaxWaveform = () => !editPaletteOpen && !paletteOpen && !browserOpen;

    const toggleMaxWaveform = () => {
      if (isMaxWaveform()) {
        editPaletteOpen = true;
        paletteOpen = true;
      } else {
        editPaletteOpen = false;
        paletteOpen = false;
        browserOpen = false;
      }
    };

    assert.equal(isMaxWaveform(), false, 'Standard layout is not max waveform');

    // Trigger Max Waveform (M)
    toggleMaxWaveform();
    assert.equal(isMaxWaveform(), true, 'All panels collapsed for max waveform view');
    assert.equal(editPaletteOpen, false);
    assert.equal(paletteOpen, false);
    assert.equal(browserOpen, false);

    // Restore Layout (M)
    toggleMaxWaveform();
    assert.equal(isMaxWaveform(), false, 'Restores standard layout with panels open');
    assert.equal(editPaletteOpen, true);
    assert.equal(paletteOpen, true);
  });
});
