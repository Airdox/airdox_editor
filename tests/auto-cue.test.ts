import { describe, it, expect } from 'vitest';
import { generateAutoCuesForTrack } from '../src/audio/mixAnalysis';
import { TrackModel, DataOrigin } from '../src/types/rekordbox';

describe('Auto-Cue Generation', () => {
  it('should generate cues for drops and breakdowns', () => {
    const mockTrack = {
      id: 'test',
      title: 'Test',
      duration: 300,
      bpm: 128,
      phrases: [
        { name: 'INTRO', startBar: 1, endBar: 17, startTime: 0, endTime: 30, color: '#000', origin: DataOrigin.USER_EDIT },
        { name: 'UP', startBar: 17, endBar: 33, startTime: 30, endTime: 60, color: '#000', origin: DataOrigin.USER_EDIT },
        { name: 'DROP', startBar: 33, endBar: 65, startTime: 60, endTime: 120, color: '#000', origin: DataOrigin.USER_EDIT },
        { name: 'BREAKDOWN', startBar: 65, endBar: 81, startTime: 120, endTime: 150, color: '#000', origin: DataOrigin.USER_EDIT }
      ]
    } as unknown as TrackModel;

    const cues = generateAutoCuesForTrack(mockTrack);
    
    // Should generate for UP, DROP, BREAKDOWN. That's 3 locations.
    // Generates 1 Hot Cue and 1 Memory Cue per location = 6 cues.
    expect(cues.length).toBe(6);
    
    const hotCues = cues.filter(c => c.type === 'HOT_CUE');
    expect(hotCues.length).toBe(3);
    expect(hotCues[0].letter).toBe('A'); // UP
    expect(hotCues[1].letter).toBe('B'); // DROP
    expect(hotCues[2].letter).toBe('C'); // BREAKDOWN
  });
});
