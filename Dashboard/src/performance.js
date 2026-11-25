// Contains all performance-related functionality for the Drone Choir system

import { VOICE_RANGES } from './voiceTypes';

// Play each voice's A note once for 10 seconds. Do not queue anything after it.
const startUnison = (voiceModuleRefs, initSharedAudioContext, setIsAllPlaying) => {
  console.log('Playing each voice test note once for 10 seconds');

  const ctx = initSharedAudioContext();

  Object.entries(voiceModuleRefs).forEach(([voiceType, ref]) => {
    if (!ref.current) return;

    const voiceRange = VOICE_RANGES[voiceType];
    const voiceNote = {
      frequency: voiceRange.hertz,
      duration: 10,
      note: voiceRange.note,
      testOnly: true,
    };

    ref.current.stopAutoGeneration?.();
    ref.current.clearQueue();
    ref.current.startPerformance?.(ctx, { testOnly: true, note: voiceNote });
    console.log(`Playing test note ${voiceNote.note} (${voiceNote.frequency} Hz) on ${voiceType}`);
  });

  setIsAllPlaying(true);
};

// Arm all voice modules (unlock audio) and wait for broadcasted notes.
// Does not generate or play pitches until drone-update data arrives.
const startAll = (voiceModuleRefs, initSharedAudioContext, setIsAllPlaying) => {
  const ctx = initSharedAudioContext();

  Object.entries(voiceModuleRefs).forEach(([voiceType, ref]) => {
    if (!ref.current) return;

    ref.current.stopAutoGeneration?.();
    ref.current.clearQueue?.();
    if (typeof ref.current.armStandby === 'function') {
      ref.current.armStandby(ctx);
    }
    console.log(`Armed ${voiceType} — waiting for broadcasted notes`);
  });

  if (typeof setIsAllPlaying === 'function') {
    setIsAllPlaying(false);
  }

  return {};
};

// Stop all voice modules
const stopAll = (voiceModuleRefs, setIsAllPlaying) => {
  Object.values(voiceModuleRefs).forEach(ref => {
    if (ref.current && ref.current.stopPerformance) {
      ref.current.stopPerformance();
    }
  });
  
  setIsAllPlaying(false);
};

// Export all functions
export {
  startUnison,
  startAll,
  stopAll
};