import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { VOICE_RANGES, generateRandomNote, getNoteName } from './voiceTypes';
import { STREAMING_CONFIG } from './streamingConfig';
import { buildFadeOutWavObjectUrl, buildToneWavObjectUrl, PLAYBACK_FADE_SECONDS, STOP_FADE_SECONDS } from './toneWav';
import { queueForVoice } from './droneList';
import './VoiceModule.css';

const scheduleNoteEnvelope = (gainNode, startTime, duration, peak) => {
  const safeDuration = Math.max(0.05, Number(duration) || 0);
  const fade = Math.min(PLAYBACK_FADE_SECONDS, safeDuration / 2);
  const peakAt = startTime + fade;
  const releaseAt = startTime + safeDuration - fade;
  const end = startTime + safeDuration;
  const gain = gainNode.gain;
  gain.cancelScheduledValues(startTime);
  gain.setValueAtTime(0, startTime);
  gain.linearRampToValueAtTime(peak, peakAt);
  if (releaseAt > peakAt + 0.001) {
    gain.setValueAtTime(peak, releaseAt);
  }
  gain.linearRampToValueAtTime(0, end);
  return end;
};

const isValidAudioContext = (ctx) =>
  Boolean(ctx && typeof ctx.createAnalyser === 'function' && ctx.state !== 'closed');

const safeCloseAudioContext = (ctx) => {
  if (!ctx || ctx.state === 'closed') return;
  try {
    ctx.close();
  } catch (error) {
    // Ignore double-close during Strict Mode remount / page unload
    if (!String(error?.message || error).includes('closed')) {
      console.warn('AudioContext close failed:', error);
    }
  }
};

const getLegacyApiBaseUrl = () => (
  process.env.REACT_APP_LEGACY_API_URL
  || STREAMING_CONFIG.SERVER_URL.replace(/^ws/i, 'http')
);

const VoiceModule = forwardRef(({ 
  voiceType,
  voiceRange: voiceRangeProp,
  onPlayStateChange, 
  sharedAudioContext, 
  onSoloToggle, 
  isSoloMode, 
  isCurrentSolo, 
  isViewerMode = false,
  isSingleMode = false,
  soloVoice = null,
  onNoteQueueUpdate,
  onCurrentNoteChange,
}, ref) => {
  // State variables
  const [currentNote, setCurrentNote] = useState(null);
  const [nextNote, setNextNote] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [countdownTime, setCountdownTime] = useState(0);
  const [audioContext, setAudioContext] = useState(null);
  const [visualData, setVisualData] = useState({ frequency: 0, amplitude: 0 });
  const visualDataRef = useRef({ frequency: 0, amplitude: 0 });
  const [autoGenerate, setAutoGenerate] = useState(false);
  const [audioQueue, setAudioQueue] = useState([]);
  const [streamClient, setStreamClient] = useState(null);
  const [isSolo, setIsSolo] = useState(false);
  const [isSelected, setIsSelected] = useState(false);
  // Individual player pages need a tap before Web Audio can start
  const [audioUnlocked, setAudioUnlocked] = useState(!(isViewerMode || isSingleMode));
  const [volume, setVolume] = useState(1);

  const voiceRange = voiceRangeProp || VOICE_RANGES[voiceType];
  const safeVoiceRange = voiceRange;
  const isMasterMode = !isViewerMode && !isSingleMode;
  
  // Refs
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const oscillatorRef = useRef(null);
  const gainNodeRef = useRef(null);
  const liveAudioNodesRef = useRef([]);
  const volumeGainNodeRef = useRef(null);
  const volumeGainContextRef = useRef(null);
  const analyserRef = useRef(null);
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  const autoGenIntervalRef = useRef(null);
  const audioContextRef = useRef(null);
  const autoGenerateRef = useRef(false);
  const currentNoteRef = useRef(null);
  const nextNoteRef = useRef(null);
  const audioUnlockedRef = useRef(audioUnlocked);
  const volumeRef = useRef(1);
  const pendingRemoteStartRef = useRef(false);
  const testAudioRef = useRef(null);
  const noteObjectUrlRef = useRef(null);
  const htmlAudioPlayingRef = useRef(false);
  const htmlAudioTokenRef = useRef(0);
  const htmlFadeTokenRef = useRef(0);
  const htmlFadeRafRef = useRef(null);
  const htmlFrequencyRef = useRef(0);
  const htmlFadeStartedAtRef = useRef(0);
  const fadingWebNodesRef = useRef([]);
  const stopVisualTimerRef = useRef(null);
  const remoteStoppedRef = useRef(false);

  useEffect(() => {
    autoGenerateRef.current = autoGenerate;
  }, [autoGenerate]);

  useEffect(() => {
    currentNoteRef.current = currentNote;
  }, [currentNote]);

  useEffect(() => {
    nextNoteRef.current = nextNote;
  }, [nextNote]);

  // Tell the dashboard controller to re-broadcast when the active note changes
  const prevBroadcastNoteRef = useRef(null);
  useEffect(() => {
    if (!onCurrentNoteChange || isViewerMode || isSingleMode) return;
    if (!currentNote) return;

    const noteKey = `${currentNote.droneId || ''}:${currentNote.note}:${Number(currentNote.frequency || 0).toFixed(2)}`;

    if (prevBroadcastNoteRef.current === noteKey) return;
    prevBroadcastNoteRef.current = noteKey;
    onCurrentNoteChange(voiceType, currentNote);
  }, [currentNote, onCurrentNoteChange, isViewerMode, isSingleMode, voiceType]);

  useEffect(() => {
    audioUnlockedRef.current = audioUnlocked;
  }, [audioUnlocked]);

  const ensureVolumeGainNode = (ctx) => {
    if (!ctx || ctx.state === 'closed') return null;

    if (
      volumeGainNodeRef.current
      && volumeGainContextRef.current === ctx
    ) {
      return volumeGainNodeRef.current;
    }

    if (volumeGainNodeRef.current) {
      try {
        volumeGainNodeRef.current.disconnect();
      } catch (_) {
        // ignore
      }
    }

    const volumeGain = ctx.createGain();
    const level = Math.max(0, Math.min(1, Number.isFinite(volumeRef.current) ? volumeRef.current : 1));
    const soloMute = (isSoloMode && !isCurrentSolo) ? 0 : 1;
    volumeGain.gain.value = level * soloMute;
    volumeGainNodeRef.current = volumeGain;
    volumeGainContextRef.current = ctx;
    return volumeGain;
  };

  const applyOutputVolume = (level = volumeRef.current) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(Number(level)) ? Number(level) : 1));
    volumeRef.current = clamped;

    if (testAudioRef.current) {
      try {
        testAudioRef.current.volume = clamped;
      } catch (_) {
        // ignore
      }
    }

    const volumeGain = volumeGainNodeRef.current;
    if (volumeGain) {
      try {
        const soloMute = (isSoloMode && !isCurrentSolo) ? 0 : 1;
        const target = clamped * soloMute;
        const ctx = audioContextRef.current;
        if (ctx && ctx.state !== 'closed') {
          volumeGain.gain.cancelScheduledValues(ctx.currentTime);
          volumeGain.gain.setValueAtTime(target, ctx.currentTime);
        } else {
          volumeGain.gain.value = target;
        }
      } catch (_) {
        // ignore
      }
    }
  };

  useEffect(() => {
    applyOutputVolume(volume);
  }, [volume, isSoloMode, isCurrentSolo]);

  useEffect(() => {
    setIsSolo(isCurrentSolo);
    setIsSelected(isCurrentSolo);
  }, [isCurrentSolo]);

  const ensureAudioContext = () => {
    if (!isValidAudioContext(audioContextRef.current)) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      setAudioContext(audioContextRef.current);
    }
    return audioContextRef.current;
  };

  // iOS/WebKit often needs a real sound scheduled inside the user gesture
  const playSilentUnlockTone = (ctx) => {
    if (!ctx || ctx.state === 'closed') return;
    try {
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch (_) {
      // ignore
    }
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(0);
      osc.stop(ctx.currentTime + 0.05);
    } catch (_) {
      // ignore
    }
  };

  const resumeAudioContext = async () => {
    const ctx = ensureAudioContext();
    if (!ctx || ctx.state === 'closed') return false;
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      try {
        await ctx.resume();
        console.log(`${voiceType} AudioContext resumed (${ctx.state})`);
      } catch (error) {
        console.error(`${voiceType} failed to resume AudioContext:`, error);
        return false;
      }
    }
    return ctx.state === 'running';
  };

  const unlockingRef = useRef(false);

  const unlockAudio = async (event) => {
    if (event?.preventDefault) event.preventDefault();
    if (unlockingRef.current) return audioUnlockedRef.current;
    if (audioUnlockedRef.current && isToneActive()) return true;
    unlockingRef.current = true;

    try {
      // Unlock with the same HTML5 WAV path that works on phones
      try {
        const unlockUrl = buildToneWavObjectUrl(440, 0.08);
        const audioEl = testAudioRef.current || new Audio();
        if (!testAudioRef.current) testAudioRef.current = audioEl;
        audioEl.playsInline = true;
        audioEl.setAttribute('playsinline', 'true');
        audioEl.setAttribute('webkit-playsinline', 'true');
        audioEl.volume = volumeRef.current;
        audioEl.muted = false;
        audioEl.src = unlockUrl;
        const unlockPlay = audioEl.play();
        if (unlockPlay && typeof unlockPlay.catch === 'function') {
          unlockPlay.catch((error) => {
            console.warn(`${voiceType} unlock HTML play issue:`, error.message);
          });
        }
        window.setTimeout(() => {
          try {
            URL.revokeObjectURL(unlockUrl);
          } catch (_) {
            // ignore
          }
        }, 500);
      } catch (error) {
        console.warn(`${voiceType} HTML unlock failed:`, error);
      }

      // Also warm Web Audio for dashboard-style paths / viz
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          if (!isValidAudioContext(audioContextRef.current)) {
            audioContextRef.current = new Ctx();
            setAudioContext(audioContextRef.current);
          }
          const ctx = audioContextRef.current;
          playSilentUnlockTone(ctx);
          if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
            ctx.resume().catch(() => {});
          }
        }
      } catch (_) {
        // ignore
      }

      setAudioUnlocked(true);
      audioUnlockedRef.current = true;
      document.body.classList.add('audio-enabled');

      // Start any note the dashboard already sent — must stay in this tap turn
      if (
        pendingRemoteStartRef.current
        || isPlayingRef.current
        || currentNoteRef.current
        || audioQueueRef.current.length > 0
      ) {
        pendingRemoteStartRef.current = false;
        isPlayingRef.current = true;
        setIsPlaying(true);

        if (currentNoteRef.current) {
          playNoteWithHtmlAudio(currentNoteRef.current);
        } else {
          playNextInQueue();
        }
      }

      return true;
    } finally {
      unlockingRef.current = false;
    }
  };

  // Resume if the phone suspends audio when the tab is backgrounded
  useEffect(() => {
    if (!(isViewerMode || isSingleMode)) return undefined;

    const tryResume = () => {
      const ctx = audioContextRef.current;
      if (!ctx || ctx.state === 'closed') return;
      if ((ctx.state === 'suspended' || ctx.state === 'interrupted') && audioUnlockedRef.current) {
        ctx.resume().catch(() => {});
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') tryResume();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', tryResume);
    window.addEventListener('focus', tryResume);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', tryResume);
      window.removeEventListener('focus', tryResume);
    };
  }, [isViewerMode, isSingleMode]);
  
  // Resume playback if notes are queued but nothing is playing
  useEffect(() => {
    if (!isPlaying) return;

    const queueCheckInterval = setInterval(() => {
      if (!audioUnlockedRef.current) return;
      if (!isPlayingRef.current || remoteStoppedRef.current) return;
      if (!oscillatorRef.current && !htmlAudioPlayingRef.current) {
        if (currentNoteRef.current) {
          console.log(`${voiceType} periodic queue check triggered`);
          playNote(currentNoteRef.current);
        } else if (audioQueueRef.current.length > 0) {
          console.log(`${voiceType} periodic queue check triggered`);
          playNextInQueue();
        }
      }
    }, 2000);

    return () => {
      clearInterval(queueCheckInterval);
    };
  }, [isPlaying, voiceType]);
  
  // Initialize audio context on component mount
  useEffect(() => {
    // Phones: do NOT create AudioContext until Enable Audio tap (iOS requirement)
    if (isViewerMode || isSingleMode) {
      return () => {
        if (autoGenIntervalRef.current) {
          clearInterval(autoGenIntervalRef.current);
          autoGenIntervalRef.current = null;
        }
        const ctx = audioContextRef.current;
        if (ctx && ctx !== sharedAudioContext) {
          safeCloseAudioContext(ctx);
        }
      };
    }

    // Dashboard: create immediately
    if (isValidAudioContext(sharedAudioContext)) {
      audioContextRef.current = sharedAudioContext;
      setAudioContext(sharedAudioContext);
    } else if (!isValidAudioContext(audioContextRef.current)) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      setAudioContext(audioContextRef.current);
    }

    return () => {
      if (autoGenIntervalRef.current) {
        clearInterval(autoGenIntervalRef.current);
        autoGenIntervalRef.current = null;
      }
      const ctx = audioContextRef.current;
      if (ctx && ctx !== sharedAudioContext) {
        safeCloseAudioContext(ctx);
      }
    };
  }, [sharedAudioContext, isViewerMode, isSingleMode]);

  useEffect(() => {
    // Add or remove 'playing' class based on isPlaying state
    const container = document.querySelector('.single-voice-container');
    if (container) {
      if (isPlaying) {
        container.classList.add('playing');
      } else {
        container.classList.remove('playing');
      }
    }
  }, [isPlaying]);
  
  // Expose methods to parent component via ref
  useImperativeHandle(ref, () => ({
    setIsSolo,
    setIsSelected,
    startPerformance: (providedContext = null, options = {}) => {
      const validContext = isValidAudioContext(providedContext) ? providedContext : null;

      if (validContext) {
        audioContextRef.current = validContext;
        setAudioContext(validContext);
      }

      startPerformance(validContext, options);
    },
    armStandby: (providedContext = null) => {
      const validContext = isValidAudioContext(providedContext)
        ? providedContext
        : ensureAudioContext();

      if (validContext) {
        audioContextRef.current = validContext;
        setAudioContext(validContext);
        playSilentUnlockTone(validContext);
        if (validContext.state === 'suspended' || validContext.state === 'interrupted') {
          validContext.resume().catch((error) => {
            console.warn(`${voiceType} standby resume failed:`, error);
          });
        }
      }

      stopAutoGeneration();
      updateAudioQueue([]);
      audioUnlockedRef.current = true;
      setAudioUnlocked(true);
      console.log(`${voiceType} armed — waiting for broadcasted notes`);
    },
    unlockAudio,
    getCurrentNote: () => currentNoteRef.current,
    getNextNote: () => nextNoteRef.current,
    setVolume: (level) => {
      const raw = Number(level);
      const next = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
      applyOutputVolume(next);
      setVolume(next);
    },
    getVolume: () => volumeRef.current,
    stopPerformance: () => {
      stopPerformance();
    },
    stopAutoGeneration: () => {
      stopAutoGeneration();
    },
    clearQueue: () => {
      updateAudioQueue([]);
      console.log(`${voiceType} queue cleared`);
    },
    addSpecificNote: (note) => {
      const newQueue = [...audioQueueRef.current, note];
      updateAudioQueue(newQueue);
      console.log(`${voiceType} added specific note: ${note.note} (${note.frequency.toFixed(2)} Hz)`);
    },
    getQueue: () => audioQueueRef.current.slice(),
    loadQueue: (notes) => {
      const queue = Array.isArray(notes) ? notes.filter(Boolean) : [];
      stopAutoGeneration();
      remoteStoppedRef.current = false;
      stopWebOscillator({ immediate: true });
      stopHtmlAudio({ immediate: true });
      updateAudioQueue(queue);
      console.log(`${voiceType} loaded ${queue.length} queued drones`);
    },
    // Force this module to show/play exactly what the dashboard is playing
    syncToNote: async (note, upcomingNote = null, queue = null) => {
      if (!note) return;

      const current = currentNoteRef.current;
      const sameNote = Boolean(
        current
        && current.note === note.note
        && (current.droneId || null) === (note.droneId || null)
      );
      const rest = Array.isArray(queue)
        ? queue.filter(Boolean)
        : (upcomingNote ? [upcomingNote] : []);
      const nextChanged =
        (rest[0]?.note || null) !== (nextNoteRef.current?.note || null)
        || (rest[0]?.droneId || null) !== (nextNoteRef.current?.droneId || null)
        || rest.length !== audioQueueRef.current.length;

      stopAutoGeneration();

      // Same current note — still refresh Coming Next / queue without restarting audio
      if (sameNote && isPlayingRef.current) {
        if (nextChanged) {
          updateAudioQueue(rest);
        }
        return;
      }

      updateAudioQueue(rest);

      setCurrentNote(note);
      currentNoteRef.current = note;
      startCountdown(note.duration || 10);

      remoteStoppedRef.current = false;
      isPlayingRef.current = true;
      setIsPlaying(true);

      if ((isViewerMode || isSingleMode) && !audioUnlockedRef.current) {
        pendingRemoteStartRef.current = true;
        console.warn(`${voiceType} synced note waiting for Enable Audio: ${note.note}`);
        return;
      }

      console.log(`${voiceType} syncing to dashboard note: ${note.note} (${note.frequency.toFixed(2)} Hz)`);

      // Players use HTML5 WAV — do not require Web Audio resume
      if (isViewerMode || isSingleMode) {
        playNote(note);
        return;
      }

      const resumed = await resumeAudioContext();
      if (!resumed) {
        pendingRemoteStartRef.current = true;
        console.warn(`${voiceType} could not resume audio for synced note`);
        return;
      }

      await playNote(note);
    },
    get isPlaying() {
      return isPlayingRef.current;
    },
    get audioUnlocked() {
      return audioUnlockedRef.current;
    },
    toggleSolo: () => {
      console.log(`Toggling solo for ${voiceType}`);
      const newSoloState = !isSolo;
      setIsSolo(newSoloState);
      
      if (onSoloToggle) {
        console.log(`Calling onSoloToggle with ${voiceType}, ${newSoloState}`);
        onSoloToggle(voiceType, newSoloState);
      }
    },
    get isSolo() {
      return isSolo;
    },
    adjustVolume: (soloVolume) => {
      adjustVolumeForSolo(soloVolume);
    },
    get isSelected() {
      return isSelected;
    }
  }));

  // Initialize audio context
  const initAudio = () => {
    // If no context exists, create a new one
    if (!audioContext) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      
      setAudioContext(ctx);
      analyserRef.current = analyser;
      
      return { ctx, analyser };
    }
    
    // If there's no analyser yet but we have a context, create one
    if (!analyserRef.current && audioContext) {
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      
      return { ctx: audioContext, analyser };
    }
    
    return { ctx: audioContext, analyser: analyserRef.current };
  };
  
  // Sync the queue ref with state
  useEffect(() => {
    audioQueueRef.current = audioQueue;
  }, [audioQueue]);
  
  // Notify parent only when play state actually changes
  const prevPlayingRef = useRef(isPlaying);
  useEffect(() => {
    if (!onPlayStateChange || prevPlayingRef.current === isPlaying) return;
    prevPlayingRef.current = isPlaying;
    onPlayStateChange(isPlaying);
  }, [isPlaying, onPlayStateChange]);
  
  // Generate a random frequency within the voice range
  const generateRandomFrequency = () => {
    return Math.random() * (safeVoiceRange.max - safeVoiceRange.min) + safeVoiceRange.min;
  };
  
  const generateRandomDuration = () => {
    // return Math.random() * 5 + 3; // 3 to 8 seconds
    return 10;
  };
  
  // Generate a note name from a frequency (simplified)
  const getNoteName = (frequency) => {
    // This is a simplified mapping that doesn't account for exact frequencies
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const A4 = 440.0;
    const A4Index = 9; // Index of A in noteNames
    
    // Calculate how many half steps away from A4
    const halfStepsFromA4 = Math.round(12 * Math.log2(frequency / A4));
    
    // Calculate octave and note
    const octave = Math.floor((halfStepsFromA4 + A4Index) / 12) + 4;
    const noteIndex = (((halfStepsFromA4 + A4Index) % 12) + 12) % 12;
    
    return noteNames[noteIndex] + octave;
  };
  
  // Generate a new note
  const generateNewNote = () => {
    const frequency = generateRandomFrequency();
    const duration = generateRandomDuration();
    const note = getNoteName(frequency);
    
    return {
      frequency,
      duration,
      note
    };
  };
  
  // Keep "Coming Next" aligned with the head of the remaining queue
  const syncNextNoteFromQueue = (queue) => {
    const upcoming = Array.isArray(queue) && queue.length > 0 ? queue[0] : null;
    setNextNote(upcoming);
    nextNoteRef.current = upcoming;
  };

  // On the dashboard master, keep upcoming notes ready for display + playback
  const ensureQueueDepth = (minDepth = 1) => {
    if (!isMasterMode || isSingleMode) return;

    const currentLength = audioQueueRef.current.length;
    if (currentLength >= minDepth) return;

    const extras = [];
    for (let i = 0; i < minDepth - currentLength; i += 1) {
      extras.push(generateNewNote());
    }
    updateAudioQueue([...audioQueueRef.current, ...extras]);
  };

  // Auto-generate and add new notes to the queue
  const startAutoGeneration = () => {
      // Only the dashboard master can auto-generate notes
      if (!isMasterMode || isSingleMode) {
        console.log(`${voiceType} cannot auto-generate notes in viewer/single mode`);
        return;
      }
      
      // Clear any existing interval
      if (autoGenIntervalRef.current) {
        clearInterval(autoGenIntervalRef.current);
      }

      autoGenerateRef.current = true;
      setAutoGenerate(true);

      // Seed current + next so the queue / Coming Next populate immediately
      ensureQueueDepth(2);
      
      // Keep topping up the queue while performing
      autoGenIntervalRef.current = setInterval(() => {
        if (!isPlayingRef.current) return;

        const newNote = generateNewNote();
        console.log(`${voiceType} auto-generating new note: ${newNote.note}`);
        
        updateAudioQueue(prevQueue => [...prevQueue, newNote]);

        if (!oscillatorRef.current && !htmlAudioPlayingRef.current && audioQueueRef.current.length > 0) {
          playNextInQueue();
        }
      }, 5000);
    };
  
  // Stop auto generation
  const stopAutoGeneration = () => {
    if (autoGenIntervalRef.current) {
      clearInterval(autoGenIntervalRef.current);
      autoGenIntervalRef.current = null;
    }
    
    autoGenerateRef.current = false;
    setAutoGenerate(false);
  };
  
  // Play the next note in the queue
  const playNextInQueue = () => {
    if (remoteStoppedRef.current || !isPlayingRef.current) {
      return;
    }

    console.log(`${voiceType} playNextInQueue called, queue length: ${audioQueueRef.current.length}`);
    
    if (audioQueueRef.current.length === 0) {
      console.log(`${voiceType} queue is empty, checking auto-generate`);
      const finishedNote = currentNoteRef.current;

      if (finishedNote?.testOnly) {
        console.log(`${voiceType} test note finished — not queueing anything else`);
        stopPerformance();
      } else if (
        finishedNote?.droneId
        && !finishedNote.testOnly
        && isPlayingRef.current
        && !remoteStoppedRef.current
      ) {
        const looped = queueForVoice(voiceType);
        if (looped.length > 0) {
          console.log(`${voiceType} finished the chord list — looping from the start`);
          updateAudioQueue(looped);
          playNextInQueue();
          return;
        }
      } else if (autoGenerateRef.current && isPlayingRef.current && isMasterMode) {
        console.log(`${voiceType} auto-generate is on, generating current + next notes`);
        // Generate current + lookahead so Coming Next stays populated
        updateAudioQueue([generateNewNote(), generateNewNote()]);
        playNextInQueue();
      } else if (
        (isViewerMode || isSingleMode)
        && isPlayingRef.current
        && !remoteStoppedRef.current
        && finishedNote
        && !finishedNote.droneId
      ) {
        // Viewer/single-voice pages loop the current note until the dashboard sends a new one
        console.log(`${voiceType} viewer looping current note: ${finishedNote.note}`);
        updateAudioQueue([finishedNote]);
        playNextInQueue();
      } else {
        console.log(`${voiceType} no more notes and auto-generate is off`);
        setCurrentNote(null);
        currentNoteRef.current = null;
        setNextNote(null);
        nextNoteRef.current = null;
      }
      return;
    }
    
    // Get the next note from the queue
    const nextNoteToPlay = audioQueueRef.current[0];
    setCurrentNote(nextNoteToPlay);
    currentNoteRef.current = nextNoteToPlay;
    console.log("NEXT NOTE ", nextNoteToPlay);
    
    // Remove the first item from the queue
    let newQueue = audioQueueRef.current.slice(1);

    // At the end of the chord list, queue the file again so the next chord is chord 1.
    if (newQueue.length === 0 && nextNoteToPlay?.droneId && !nextNoteToPlay.testOnly) {
      const looped = queueForVoice(voiceType);
      if (looped.length > 0) {
        newQueue = looped;
      }
    }

    // Immediately refill lookahead on the dashboard so Coming Next never goes blank
    if (newQueue.length === 0 && autoGenerateRef.current && isMasterMode) {
      newQueue = [generateNewNote()];
    }

    updateAudioQueue(newQueue);
    
    // Start countdown
    startCountdown(nextNoteToPlay.duration);
    
    // Check if this is a scheduled note
    if (nextNoteToPlay.scheduledStartTime && !isViewerMode && !isSingleMode) {
      // Use scheduled playback (dashboard / Web Audio only)
      playScheduledNote(nextNoteToPlay);
    } else {
      // Players use HTML5 WAV; dashboard uses Web Audio via playNote
      playNote(nextNoteToPlay);
    }
  };

  const updateAudioQueue = (newQueue) => {
    let updatedQueue;
    if (typeof newQueue === 'function') {
      updatedQueue = newQueue(audioQueueRef.current);
    } else {
      updatedQueue = newQueue;
    }
    
    // Ensure the queue is always an array
    updatedQueue = Array.isArray(updatedQueue) ? updatedQueue : [];
    
    // Update both the ref and the state
    audioQueueRef.current = updatedQueue;
    setAudioQueue(updatedQueue);
    syncNextNoteFromQueue(updatedQueue);
    
    console.log(`DASHBOARD ${voiceType} queue updated:`, updatedQueue.map(note => ({
      note: note.note,
      frequency: note.frequency.toFixed(2),
      duration: note.duration.toFixed(2)
    })));
    
    // Notify parent about the queue update
    if (onNoteQueueUpdate) {
      onNoteQueueUpdate(updatedQueue);
    }
    
    // Legacy REST sync is only used by standalone voice pages (Tenor/Alto/Bass)
    if (!sharedAudioContext) {
      return;
    }

    fetch(`${getLegacyApiBaseUrl()}/api/voice/${voiceType}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: updatedQueue })
    })
    .then(response => {
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }

      console.log(`${voiceType} queue sent to server:`, updatedQueue.map(note => ({
        note: note.note,
        frequency: note.frequency.toFixed(2),
        duration: note.duration.toFixed(2)
      })));
      return response.json();
    })
    .catch(error => {
      console.warn(`${voiceType} legacy server unavailable:`, error.message);
    });
  };
  
  const isToneActive = () =>
    Boolean(oscillatorRef.current) || Boolean(htmlAudioPlayingRef.current);

  const stopHtmlAudio = ({ immediate = false, fadeSeconds = PLAYBACK_FADE_SECONDS } = {}) => {
    const audioEl = testAudioRef.current;
    const releaseUrl = () => {
      if (!noteObjectUrlRef.current) return;
      try {
        URL.revokeObjectURL(noteObjectUrlRef.current);
      } catch (_) {
        // ignore
      }
      noteObjectUrlRef.current = null;
    };

    const cleanup = () => {
      if (htmlFadeRafRef.current) {
        clearTimeout(htmlFadeRafRef.current);
        htmlFadeRafRef.current = null;
      }
      htmlFadeStartedAtRef.current = 0;
      htmlFadeTokenRef.current += 1;
      htmlAudioTokenRef.current += 1;
      htmlAudioPlayingRef.current = false;
      if (audioEl) {
        try {
          audioEl.onended = null;
          audioEl.onerror = null;
          audioEl.pause();
          audioEl.removeAttribute('src');
          audioEl.load();
          audioEl.volume = volumeRef.current;
        } catch (_) {
          // ignore
        }
      }
      releaseUrl();
    };

    if (immediate && animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (!audioEl || immediate || audioEl.paused) {
      cleanup();
      return;
    }

    if (htmlFadeStartedAtRef.current) return;

    try {
      audioEl.onended = null;
      audioEl.onerror = null;
    } catch (_) {
      // ignore
    }

    // Phone browsers ignore audio.volume, so replace the clip with one that
    // falls from full level to silence inside the samples.
    const frequency = htmlFrequencyRef.current || 440;
    const fadeFor = Math.max(0.05, fadeSeconds);
    const fadeUrl = buildFadeOutWavObjectUrl(frequency, fadeFor);
    const previousUrl = noteObjectUrlRef.current;
    noteObjectUrlRef.current = fadeUrl;
    if (previousUrl && previousUrl !== fadeUrl) {
      try {
        URL.revokeObjectURL(previousUrl);
      } catch (_) {
        // ignore
      }
    }
    htmlFadeStartedAtRef.current = performance.now();
    audioEl.volume = volumeRef.current || 1;
    audioEl.src = fadeUrl;
    const fadePlay = audioEl.play();
    if (fadePlay && typeof fadePlay.catch === 'function') {
      fadePlay.catch(() => {
        cleanup();
      });
    }
    htmlFadeRafRef.current = window.setTimeout(() => {
      htmlFadeRafRef.current = null;
      cleanup();
    }, (fadeFor + 0.05) * 1000);
  };

  const silenceGainNode = (node) => {
    if (!node?.gain) return;
    const ctx = audioContextRef.current;
    try {
      if (ctx && ctx.state !== 'closed') {
        node.gain.cancelScheduledValues(ctx.currentTime);
        node.gain.setValueAtTime(0, ctx.currentTime);
      } else {
        node.gain.value = 0;
      }
    } catch (_) {
      // ignore
    }
    try {
      node.disconnect();
    } catch (_) {
      // ignore
    }
  };

  const silenceOscillator = (osc, gainNode) => {
    silenceGainNode(gainNode);
    if (!osc) return;
    try {
      osc.onended = null;
    } catch (_) {
      // ignore
    }
    try {
      osc.disconnect();
    } catch (_) {
      // ignore
    }
    try {
      osc.stop();
    } catch (_) {
      // already scheduled to stop
    }
  };

  const stopWebOscillator = ({ immediate = false, fadeSeconds = PLAYBACK_FADE_SECONDS } = {}) => {
    const tracked = liveAudioNodesRef.current.splice(0);
    if (oscillatorRef.current || gainNodeRef.current) {
      tracked.push({
        osc: oscillatorRef.current,
        gainNode: gainNodeRef.current,
      });
    }
    oscillatorRef.current = null;
    gainNodeRef.current = null;

    const ctx = audioContextRef.current;
    const canFade = !immediate && ctx && ctx.state !== 'closed';

    if (immediate) {
      fadingWebNodesRef.current.splice(0).forEach(({ osc, gainNode, timer }) => {
        if (timer) clearTimeout(timer);
        silenceOscillator(osc, gainNode);
      });
    }

    if (!canFade) {
      tracked.forEach(({ osc, gainNode }) => silenceOscillator(osc, gainNode));
    } else if (tracked.length > 0) {
      const fadeFor = Math.max(0, fadeSeconds);
      tracked.forEach(({ osc, gainNode }) => {
        if (osc) {
          try {
            osc.onended = null;
          } catch (_) {
            // ignore
          }
        }

        if (!gainNode?.gain || gainNode.__fading) {
          if (!gainNode?.gain) silenceOscillator(osc, gainNode);
          return;
        }
        gainNode.__fading = true;

        const now = ctx.currentTime;
        const param = gainNode.gain;
        try {
          const scheduled = Number(param.value);
          const current = Number.isFinite(scheduled) && scheduled > 0.001
            ? scheduled
            : (Number(gainNode.__peak) || 1);
          param.cancelScheduledValues(now);
          param.setValueAtTime(current, now);
          param.linearRampToValueAtTime(0, now + fadeFor);
        } catch (_) {
          silenceOscillator(osc, gainNode);
          return;
        }

        const entry = { osc, gainNode, timer: null };
        entry.timer = window.setTimeout(() => {
          fadingWebNodesRef.current = fadingWebNodesRef.current.filter((item) => item !== entry);
          try {
            gainNode.disconnect();
          } catch (_) {
            // ignore
          }
          try {
            osc?.disconnect();
          } catch (_) {
            // ignore
          }
        }, (fadeFor + 0.05) * 1000);
        fadingWebNodesRef.current.push(entry);
      });
    }

    if (!canFade) {
      const volumeGain = volumeGainNodeRef.current;
      if (volumeGain?.gain && ctx && ctx.state !== 'closed') {
        try {
          volumeGain.gain.cancelScheduledValues(ctx.currentTime);
          volumeGain.gain.setValueAtTime(0, ctx.currentTime);
        } catch (_) {
          // ignore
        }
      }
    }
  };

  const drawIdleLine = () => {
    if (!(isViewerMode || isSingleMode)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const container = canvas.parentElement;
    const width = Math.max(
      container?.clientWidth || 0,
      container?.offsetWidth || 0,
      canvas.clientWidth || 0,
      300
    );
    const height = Math.max(
      container?.clientHeight || 0,
      container?.offsetHeight || 0,
      canvas.clientHeight || 0,
      150
    );
    canvas.width = width;
    canvas.height = height;

    const drawCtx = canvas.getContext('2d');
    if (!drawCtx) return;
    drawCtx.fillStyle = '#1a202c';
    drawCtx.fillRect(0, 0, width, height);
    drawCtx.strokeStyle = '#63b3ed';
    drawCtx.lineWidth = 2;
    drawCtx.beginPath();
    const mid = Math.round(height / 2) + 0.5;
    drawCtx.moveTo(0, mid);
    drawCtx.lineTo(width, mid);
    drawCtx.stroke();
  };

  const startHtmlVisualizer = (frequency, duration) => {
    if (!canvasRef.current) return;

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const canvas = canvasRef.current;
    const drawCtx = canvas.getContext('2d');
    const container = canvas.parentElement;
    const width = Math.max(
      container?.clientWidth || 0,
      container?.offsetWidth || 0,
      canvas.clientWidth || 0,
      300
    );
    const height = Math.max(
      container?.clientHeight || 0,
      container?.offsetHeight || 0,
      canvas.clientHeight || 0,
      isSingleMode ? 150 : 100
    );
    canvas.width = width;
    canvas.height = height;

    const startedAt = performance.now();
    const token = htmlAudioTokenRef.current;

    const draw = () => {
      if (token !== htmlAudioTokenRef.current || !htmlAudioPlayingRef.current) {
        visualDataRef.current = { frequency: 0, amplitude: 0 };
        setVisualData({ frequency: 0, amplitude: 0 });
        if (token === htmlAudioTokenRef.current) {
          drawIdleLine();
        }
        return;
      }

      const elapsed = (performance.now() - startedAt) / 1000;
      if (elapsed >= duration) {
        visualDataRef.current = { frequency: 0, amplitude: 0 };
        setVisualData({ frequency: 0, amplitude: 0 });
        if (!isPlayingRef.current || remoteStoppedRef.current) {
          drawIdleLine();
        }
        return;
      }

      const fadeStarted = htmlFadeStartedAtRef.current;
      const fadeLevel = fadeStarted
        ? Math.max(0, 1 - ((performance.now() - fadeStarted) / (STOP_FADE_SECONDS * 1000)))
        : 1;
      const level = fadeLevel;
      const amp = (0.35 + 0.35 * Math.sin(elapsed * (frequency / 80))) * level;
      visualDataRef.current = { frequency, amplitude: amp };
      setVisualData({ frequency, amplitude: amp });

      drawCtx.fillStyle = '#1a202c';
      drawCtx.fillRect(0, 0, width, height);
      drawCtx.strokeStyle = '#63b3ed';
      drawCtx.lineWidth = 2;
      drawCtx.beginPath();
      const mid = height / 2;
      for (let x = 0; x < width; x += 1) {
        const y = mid + Math.sin((x / width) * Math.PI * 6 + elapsed * 10) * amp * mid * 0.8;
        if (x === 0) drawCtx.moveTo(x, y);
        else drawCtx.lineTo(x, y);
      }
      drawCtx.stroke();

      animationFrameRef.current = requestAnimationFrame(draw);
    };

    animationFrameRef.current = requestAnimationFrame(draw);
  };

  // Individual players: HTML5 WAV (same approach as the working Test button)
  const playNoteWithHtmlAudio = (noteData) => {
    if (!noteData) return;
    if (remoteStoppedRef.current || !isPlayingRef.current) return;

    if (!audioUnlockedRef.current) {
      console.warn(`${voiceType} waiting for Enable Audio / Test before HTML playback`);
      pendingRemoteStartRef.current = true;
      setAudioUnlocked(false);
      updateAudioQueue((queue) => [noteData, ...queue.filter((n) => n !== noteData)]);
      return;
    }

    stopWebOscillator({ immediate: true });
    stopHtmlAudio({ immediate: true });

    const frequency = Number(noteData.frequency) || safeVoiceRange.hertz || 440;
    htmlFrequencyRef.current = frequency;
    const duration = Math.max(0.5, Math.min(20, Number(noteData.duration) || 10));
    const objectUrl = buildToneWavObjectUrl(frequency, duration);
    noteObjectUrlRef.current = objectUrl;

    const audioEl = testAudioRef.current || new Audio();
    if (!testAudioRef.current) {
      testAudioRef.current = audioEl;
    }

    audioEl.playsInline = true;
    audioEl.setAttribute('playsinline', 'true');
    audioEl.setAttribute('webkit-playsinline', 'true');
    audioEl.preload = 'auto';
    audioEl.volume = volumeRef.current;
    audioEl.muted = false;
    audioEl.src = objectUrl;

    const token = htmlAudioTokenRef.current;
    htmlAudioPlayingRef.current = true;

    audioEl.onended = () => {
      if (token !== htmlAudioTokenRef.current) return;
      htmlAudioPlayingRef.current = false;
      if (noteObjectUrlRef.current === objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch (_) {
          // ignore
        }
        noteObjectUrlRef.current = null;
      }
      console.log(`${voiceType} HTML note finished: ${noteData.note}`);
      if (isPlayingRef.current) {
        playNextInQueue();
      }
    };

    audioEl.onerror = () => {
      if (token !== htmlAudioTokenRef.current) return;
      console.error(`${voiceType} HTML audio failed for ${noteData.note}`);
      htmlAudioPlayingRef.current = false;
      audioUnlockedRef.current = false;
      setAudioUnlocked(false);
      pendingRemoteStartRef.current = true;
    };

    startHtmlVisualizer(frequency, duration);

    const playResult = audioEl.play();
    console.log(
      `${voiceType} HTML playing note: ${noteData.note} (${frequency.toFixed(2)} Hz, ${duration}s)`
    );

    if (playResult && typeof playResult.then === 'function') {
      playResult.then(() => {
        if (token !== htmlAudioTokenRef.current) {
          try {
            audioEl.pause();
          } catch (_) {
            // ignore
          }
          return;
        }
        if ((remoteStoppedRef.current || !isPlayingRef.current) && !htmlFadeRafRef.current) {
          try {
            audioEl.pause();
          } catch (_) {
            // ignore
          }
        }
      }).catch((error) => {
        if (token !== htmlAudioTokenRef.current || remoteStoppedRef.current) return;
        console.error(`${voiceType} HTML play() blocked:`, error);
        htmlAudioPlayingRef.current = false;
        audioUnlockedRef.current = false;
        setAudioUnlocked(false);
        pendingRemoteStartRef.current = true;
        updateAudioQueue((queue) => [noteData, ...queue.filter((n) => n !== noteData)]);
      });
    }
  };

  // Dashboard uses Web Audio; individual players use HTML5 WAV
  const playNote = async (noteData) => {
    if (remoteStoppedRef.current || !isPlayingRef.current) return;

    if (isViewerMode || isSingleMode) {
      playNoteWithHtmlAudio(noteData);
      return;
    }

    const ctx = ensureAudioContext();
    const gainMultiplier = (isSoloMode && !isCurrentSolo) ? 0 : 1;
    // Envelope peak stays fixed; master/player volume is applied on a separate gain node
    const requestedGain = Number(noteData?.max_gain);
    const peakGain = Number.isFinite(requestedGain) && requestedGain > 0
      ? Math.min(1, requestedGain)
      : 0.9;

    if (!ctx) {
        console.error(`No audio context available for ${voiceType}`);
        return;
    }

    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      const resumed = await resumeAudioContext();
      if (remoteStoppedRef.current || !isPlayingRef.current) return;
      if (!resumed) {
        console.warn(`${voiceType} could not resume AudioContext`);
        updateAudioQueue((queue) => [noteData, ...queue.filter((n) => n !== noteData)]);
        return;
      }
    }

    if (remoteStoppedRef.current || !isPlayingRef.current) return;

    stopWebOscillator();
    stopHtmlAudio({ immediate: true });
    
    try {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      const volumeGain = ensureVolumeGainNode(ctx);
      
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(noteData.frequency, ctx.currentTime);
      
      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.__peak = peakGain * gainMultiplier;
      scheduleNoteEnvelope(
        gainNode,
        ctx.currentTime,
        noteData.duration,
        peakGain * gainMultiplier
      );

      applyOutputVolume(volumeRef.current);

      try {
        volumeGain.disconnect();
      } catch (_) {
        // ignore
      }
      
      oscillator.connect(gainNode);
      gainNode.connect(volumeGain);
      volumeGain.connect(analyser);
      analyser.connect(ctx.destination);
      
      oscillatorRef.current = oscillator;
      gainNodeRef.current = gainNode;
      liveAudioNodesRef.current.push({ osc: oscillator, gainNode });
      
      setupVisualization();

      if (remoteStoppedRef.current || !isPlayingRef.current) {
        stopWebOscillator({ immediate: true });
        return;
      }
      
      oscillator.start();
      oscillator.stop(ctx.currentTime + noteData.duration);
      
      console.log(`${voiceType} playing note: ${noteData.note} (${noteData.frequency.toFixed(2)} Hz) vol=${volumeRef.current}`);
      
      oscillator.onended = () => {
        console.log(`${voiceType} note finished: ${noteData.note} (${noteData.frequency.toFixed(2)} Hz)`);

        try {
          oscillator.disconnect();
          gainNode.disconnect();
          analyser.disconnect();
        } catch (_) {
          // ignore
        }
        
        if (oscillatorRef.current === oscillator) {
          oscillatorRef.current = null;
        }
        if (gainNodeRef.current === gainNode) {
          gainNodeRef.current = null;
        }
        
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }

        playNextInQueue();
      };
    } catch (e) {
      console.error(`Error playing note in ${voiceType}:`, e);
    }
  };

  const adjustVolumeForSolo = (soloVolume) => {
    applyOutputVolume(
      soloVolume <= 0 ? 0 : volumeRef.current
    );
  };

  // Play a note at a scheduled time
  const playScheduledNote = (noteData) => {
    if (remoteStoppedRef.current || !isPlayingRef.current) return;

    const ctx = audioContextRef.current;
    const gainMultiplier = (isSoloMode && !isCurrentSolo) ? 0 : 1;
    const requestedGain = Number(noteData?.max_gain);
    const peakGain = Number.isFinite(requestedGain) && requestedGain > 0
      ? Math.min(1, requestedGain)
      : 0.9;

    if (!ctx) {
        console.error(`No audio context available for ${voiceType}`);
        return;
    }

    stopWebOscillator();
    stopHtmlAudio({ immediate: true });
    if (remoteStoppedRef.current || !isPlayingRef.current) return;
    
    try {
      let startDelay = 0;
      
      if (noteData.scheduledStartTime) {
        const now = Date.now();
        const timeUntilStart = noteData.scheduledStartTime - now;
        
        if (timeUntilStart > 0) {
          startDelay = timeUntilStart / 1000;
          console.log(`${voiceType} scheduling note to play in ${startDelay.toFixed(2)} seconds`);
        } else {
          console.log(`${voiceType} playing note immediately (scheduled time already passed)`);
        }
      }
      
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      const volumeGain = ensureVolumeGainNode(ctx);
      
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(noteData.frequency, ctx.currentTime + startDelay);
      
      gainNode.gain.setValueAtTime(0, ctx.currentTime + startDelay);
      gainNode.__peak = peakGain * gainMultiplier;
      scheduleNoteEnvelope(
        gainNode,
        ctx.currentTime + startDelay,
        noteData.duration,
        peakGain * gainMultiplier
      );

      applyOutputVolume(volumeRef.current);
      try {
        volumeGain.disconnect();
      } catch (_) {
        // ignore
      }
      
      oscillator.connect(gainNode);
      gainNode.connect(volumeGain);
      volumeGain.connect(analyser);
      analyser.connect(ctx.destination);
      
      oscillatorRef.current = oscillator;
      gainNodeRef.current = gainNode;
      liveAudioNodesRef.current.push({ osc: oscillator, gainNode });
      
      setupVisualization();

      if (remoteStoppedRef.current || !isPlayingRef.current) {
        stopWebOscillator({ immediate: true });
        return;
      }
      
      oscillator.start();
      oscillator.stop(ctx.currentTime + startDelay + noteData.duration);
      
      console.log(`${voiceType} scheduled note: ${noteData.note} (${noteData.frequency.toFixed(2)} Hz)`);
      
      setCurrentNote(noteData);
      
      oscillator.onended = () => {
        console.log(`${voiceType} note finished: ${noteData.note} (${noteData.frequency.toFixed(2)} Hz)`);

        try {
          oscillator.disconnect();
          gainNode.disconnect();
          analyser.disconnect();
        } catch (_) {
          // ignore
        }
        
        if (oscillatorRef.current === oscillator) {
          oscillatorRef.current = null;
        }
        if (gainNodeRef.current === gainNode) {
          gainNodeRef.current = null;
        }

        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }

        playNextInQueue();
      };
    } catch (e) {
      console.error(`Error playing scheduled note in ${voiceType}:`, e);
    }
  };

  const startPerformance = async (providedContext = null, options = {}) => {
    console.log(`Starting performance for ${voiceType} - checking audio initialization`);
    const fromBroadcast = options.fromBroadcast === true;
    const testOnly = options.testOnly === true;
    const standby = options.standby === true;
    const keepExistingNotes = fromBroadcast || testOnly;
    
    const ctx = isValidAudioContext(providedContext)
      ? providedContext
      : ensureAudioContext();
    
    if (!isValidAudioContext(ctx)) {
      console.error(`Failed to initialize audio context for ${voiceType}`);
      return;
    }

    audioContextRef.current = ctx;
    setAudioContext(ctx);
    
    // Initialize analyser if not exists
    if (!analyserRef.current) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
    }

    if (standby) {
      stopAutoGeneration();
      console.log(`${voiceType} in standby — waiting for broadcasted notes`);
      return;
    }
    
    setIsPlaying(true);
    isPlayingRef.current = true;
    remoteStoppedRef.current = false;

    if (testOnly) {
      stopAutoGeneration();
      updateAudioQueue([]);
      if (options.note) {
        setCurrentNote(options.note);
        currentNoteRef.current = options.note;
        setNextNote(null);
        nextNoteRef.current = null;
        startCountdown(options.note.duration || 10);
      }
    }

    // Broadcasted notes must be used as-is. Otherwise keep current+next filled.
    if (!keepExistingNotes && !isViewerMode && !isSingleMode) {
      if (audioQueueRef.current.length === 0) {
        updateAudioQueue([generateNewNote(), generateNewNote()]);
      } else if (audioQueueRef.current.length === 1) {
        updateAudioQueue([...audioQueueRef.current, generateNewNote()]);
      } else {
        syncNextNoteFromQueue(audioQueueRef.current);
      }
    } else if (!keepExistingNotes && audioQueueRef.current.length === 0) {
      updateAudioQueue([generateNewNote()]);
    }

    // Viewer/player pages must be unlocked by a tap first
    if ((isViewerMode || isSingleMode) && !audioUnlockedRef.current) {
      pendingRemoteStartRef.current = true;
      console.warn(`${voiceType} notes queued — tap "Enable Audio" on this page to hear them`);
      return;
    }

    if (ctx.state === 'suspended') {
      const resumed = await resumeAudioContext();
      if (!resumed) {
        pendingRemoteStartRef.current = true;
        // Still show queue/next even if audio is blocked
        return;
      }
      setAudioUnlocked(true);
      audioUnlockedRef.current = true;
    }
    
    // Play the test note by itself, or the next queued note.
    setTimeout(() => {
      if (!isPlayingRef.current) return;
      if (testOnly && options.note) {
        playNote(options.note);
        return;
      }
      playNextInQueue();
    }, 50);
    
    // Viewers / individual players only play notes sent from the dashboard.
    // Broadcasted mycelial notes and the test tone should not be mixed with random auto-generation.
    if (!keepExistingNotes && !isViewerMode && !isSingleMode) {
      startAutoGeneration();
    } else {
      stopAutoGeneration();
    }
  };
  
  const countdownIntervalRef = useRef(null);

  // Handle countdown timer
  const startCountdown = (seconds) => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }

    setCountdownTime(Math.round(seconds));
    
    countdownIntervalRef.current = setInterval(() => {
      setCountdownTime(prevTime => {
        const newTime = prevTime - 1;
        if (newTime <= 0) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
          return 0;
        }
        return newTime;
      });
    }, 1000);
  };
  
// Stop the performance
  const stopPerformance = () => {
    remoteStoppedRef.current = true;
    setIsPlaying(false);
    isPlayingRef.current = false;
    pendingRemoteStartRef.current = false;

    // Clear note state immediately so dashboard stop broadcasts don't include stale notes
    setCurrentNote(null);
    currentNoteRef.current = null;
    setNextNote(null);
    nextNoteRef.current = null;
    setCountdownTime(0);

    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    
    // Always stop auto-generation on stop
    stopAutoGeneration();
    
    // Clear the queue
    updateAudioQueue([]);

    // Stop phone HTML audio + dashboard Web Audio
    stopHtmlAudio({ fadeSeconds: STOP_FADE_SECONDS });
    stopWebOscillator({ fadeSeconds: STOP_FADE_SECONDS });

    if (stopVisualTimerRef.current) {
      clearTimeout(stopVisualTimerRef.current);
    }
    stopVisualTimerRef.current = window.setTimeout(() => {
      stopVisualTimerRef.current = null;
      visualDataRef.current = { frequency: 0, amplitude: 0 };
      setVisualData({ frequency: 0, amplitude: 0 });
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      drawIdleLine();
    }, STOP_FADE_SECONDS * 1000);
    
    console.log(`${voiceType} performance stopped`);
  };
  
  // Set up waveform visualization
  const setupVisualization = () => {
    if (!canvasRef.current || !analyserRef.current) return;

    // Cancel any prior draw loop so we don't stack frames
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const analyser = analyserRef.current;

    // Ensure the canvas has a real drawing surface (often 0 on first mobile layout)
    const container = canvas.parentElement;
    const width = Math.max(
      container?.clientWidth || 0,
      container?.offsetWidth || 0,
      canvas.clientWidth || 0,
      300
    );
    const height = Math.max(
      container?.clientHeight || 0,
      container?.offsetHeight || 0,
      canvas.clientHeight || 0,
      isSingleMode ? 150 : 100
    );
    canvas.width = width;
    canvas.height = height;
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let frameCount = 0;
    
    const draw = () => {
      if (!analyserRef.current || !canvasRef.current) {
        animationFrameRef.current = null;
        return;
      }

      const drawWidth = canvas.width;
      const drawHeight = canvas.height;
      
      // Clear canvas
      ctx.fillStyle = 'rgb(20, 20, 40)';
      ctx.fillRect(0, 0, drawWidth, drawHeight);
      
      // Get waveform data
      analyser.getByteTimeDomainData(dataArray);
      
      // Draw waveform
      ctx.lineWidth = isSingleMode ? 3 : 2;
      ctx.strokeStyle = 'rgb(100, 200, 250)';
      ctx.beginPath();
      
      const sliceWidth = drawWidth / bufferLength;
      let x = 0;
      
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * drawHeight / 2;
        
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        
        x += sliceWidth;
      }
      
      ctx.lineTo(drawWidth, drawHeight / 2);
      ctx.stroke();
      
      // Update meters only when amplitude meaningfully changes (avoid reload thrash)
      frameCount += 1;
      if (frameCount % 3 === 0) {
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += Math.abs(dataArray[i] - 128);
        }
        
        const avgAmplitude = sum / bufferLength / 128;
        const nextFrequency = currentNoteRef.current ? currentNoteRef.current.frequency : 0;
        const prev = visualDataRef.current;
        if (
          Math.abs((prev.amplitude || 0) - avgAmplitude) > 0.03
          || prev.frequency !== nextFrequency
        ) {
          const next = { frequency: nextFrequency, amplitude: avgAmplitude };
          visualDataRef.current = next;
          setVisualData(next);
        }
      }
      
      animationFrameRef.current = requestAnimationFrame(draw);
    };
    
    draw();
  };

  // When playback starts on a player page, re-size and kick the visualizer once
  const didStartVizRef = useRef(false);
  useEffect(() => {
    if (!isPlaying) {
      didStartVizRef.current = false;
      return;
    }
    if (didStartVizRef.current) return;
    didStartVizRef.current = true;

    const timer = setTimeout(() => {
      if (analyserRef.current && canvasRef.current) {
        setupVisualization();
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [isPlaying, isSingleMode]);
  
  // Reset canvas on resize
  useEffect(() => {
    const handleResize = () => {
      if ((isViewerMode || isSingleMode) && !isPlayingRef.current) {
        drawIdleLine();
        return;
      }
      if (canvasRef.current) {
        const container = canvasRef.current.parentElement;
        if (container) {
          const width = Math.max(container.clientWidth, container.offsetWidth, 300);
          const height = Math.max(container.clientHeight, container.offsetHeight, isSingleMode ? 150 : 100);
          canvasRef.current.width = width;
          canvasRef.current.height = height;
        }
      }
    };
    
    window.addEventListener('resize', handleResize);
    // Delay once so flex/mobile layout has settled
    const timer = setTimeout(handleResize, 100);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timer);
      // Clean up audio resources
      if (oscillatorRef.current && audioContext) {
        try {
          oscillatorRef.current.stop();
        } catch (e) {
          console.log('Error cleaning up oscillator:', e);
        }
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      // Do NOT clear autoGenIntervalRef here — audioContext churn was killing
      // the dashboard note queue. stopPerformance / unmount handles that.
    };
  }, [audioContext, isSingleMode]);
  
  // Handle auto-generate toggle
  const handleAutoGenerateToggle = () => {
    if (autoGenerate) {
      stopAutoGeneration();
    } else {
      startAutoGeneration();
    }
  };
  
  // Add a single note to the queue
  const addNoteToQueue = () => {
    // Only the master can add notes
    if (!isMasterMode) {
      console.log(`${voiceType} cannot add notes in slave mode`);
      return;
    }
    
    const newNote = generateNewNote();
    updateAudioQueue(prevQueue => {
      const updatedQueue = [...prevQueue, newNote];
      
      // If nothing is playing, start playing the new note
      if (isPlayingRef.current && !oscillatorRef.current && !htmlAudioPlayingRef.current) {
        setTimeout(() => {
          playNextInQueue();
        }, 50);
      }
      
      return updatedQueue;
    });
  };
  
const noteLabel = (note) => (
  note?.droneId ? `${note.droneId} · ${note.note}` : note?.note
);

const formatTrackLength = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${total}s`;
};

return (
  <div className={`drone-choir-container ${isSelected ? 'selected' : ''} ${isSingleMode ? 'single-mode' : ''}`} >
    {(isSingleMode || isViewerMode) && !audioUnlocked && (
      <div
        className="audio-unlock-overlay"
        onClick={unlockAudio}
        onTouchEnd={(event) => {
          event.preventDefault();
          unlockAudio(event);
        }}
        role="button"
        tabIndex={0}
      >
        <div className="audio-unlock-card">
          <h2>Enable Audio</h2>
          <p>Phones block sound until you tap this page.</p>
          <p>Tap anywhere (and unmute the side switch if needed).</p>
          <button
            type="button"
            className="control-button start"
            onClick={(event) => {
              event.stopPropagation();
              unlockAudio(event);
            }}
            onTouchEnd={(event) => {
              event.preventDefault();
              event.stopPropagation();
              unlockAudio(event);
            }}
          >
            Enable Audio
          </button>
          {(isPlaying || audioQueue.length > 0 || currentNote) && (
            <p className="audio-unlock-pending">Notes waiting from dashboard…</p>
          )}
        </div>
      </div>
    )}

    {isSingleMode && (
      <div className="currently-playing">Currently Playing</div>
    )}
    <h2 className="voice-title">{voiceRange.label}</h2>
    
    {/* Player pages keep their controls. The dashboard only shows the voice heading. */}
    {(isViewerMode || isSingleMode) && (
    <div className="control-panel">
        <div className="control-buttons">
          {!audioUnlocked && (
            <button
              type="button"
              onClick={unlockAudio}
              className="control-button start"
            >
              Enable Audio
            </button>
          )}
          <button
            type="button"
            className="control-button reload"
            onClick={() => window.location.reload()}
          >
            Reload App
          </button>
          <audio
            ref={testAudioRef}
            playsInline
            webkit-playsinline="true"
            preload="auto"
            style={{ display: 'none' }}
          />
        </div>
    </div>
    )}
    
    {/* Current note display */}
    <div className={`note-display ${isSingleMode ? 'note-display-split' : ''}`}>
      {isSingleMode ? (
        <div className="note-split-row">
          <div className="note-split-current">
            <h2 className="section-title">Current</h2>
            {currentNote ? (
              <div className="note-details">
                <div className="note-name large-note">{noteLabel(currentNote)}</div>
                <div className="note-frequency">{currentNote.frequency.toFixed(2)} Hz</div>
                <div className="countdown">
                  <div className="countdown-time">Until Next: {countdownTime}s</div>
                </div>
              </div>
            ) : (
              <div className="no-note">—</div>
            )}
          </div>
          <div className="note-split-divider" aria-hidden="true" />
          <div className="note-split-next">
            <h2 className="section-title">Next</h2>
            {nextNote ? (
              <div className="note-details">
                <div className="note-name large-note next">{noteLabel(nextNote)}</div>
                <div className="note-frequency">{nextNote.frequency.toFixed(2)} Hz</div>
                <div className="countdown">
                  <div className="countdown-time">Length: {formatTrackLength(nextNote.duration)}</div>
                </div>
              </div>
            ) : (
              <div className="no-note">—</div>
            )}
          </div>
        </div>
      ) : (
        <>
          <h2 className="section-title">Current Note</h2>
          
          {currentNote ? (
            <div className="note-info">
              <div className="note-details">
                <div className="note-name">{noteLabel(currentNote)}</div>
                <div className="note-frequency">{currentNote.frequency.toFixed(2)} Hz</div>
              </div>
              
              <div className="countdown">
                <div className="countdown-time">
                  {countdownTime}s
                </div>
                <div className="countdown-label">until next note</div>
              </div>
            </div>
          ) : (
            <div className="no-note">No note playing</div>
          )}
        </>
      )}
    </div>
    
    {/* Next note preview (dashboard / multi view only) */}
    {!isSingleMode && nextNote && (
      <div className="note-display next-note">
        <h2 className="section-title">Coming Next</h2>
        <div className="note-info">
          <div className="note-details">
            <div className="note-name next">{noteLabel(nextNote)}</div>
            <div className="note-frequency">{nextNote.frequency.toFixed(2)} Hz</div>
          </div>
        </div>
      </div>
    )}
    
    {/* Queue display - conditionally show less detail in single mode */}
    <div className="queue-display">
      <h2 className="section-title">Note Queue ({audioQueue.length})</h2>
      <div className="queue-items">
        {audioQueue.length === 0 ? (
          <div className="empty-queue">
            {(isViewerMode || isSingleMode) && isPlaying && currentNote
              ? '↻ Looping current note'
              : 'Queue is empty'}
          </div>
        ) : (
          audioQueue.slice(0, isSingleMode ? 3 : 5).map((queueItem, index) => (
            <div key={index} className="queue-item">
              <span className="queue-note">{noteLabel(queueItem)}</span>
              <span className="queue-freq">{queueItem.frequency.toFixed(1)} Hz</span>
              <span className="queue-duration">{queueItem.duration.toFixed(1)}s</span>
            </div>
          ))
        )}
        {audioQueue.length > (isSingleMode ? 3 : 5) && (
          <div className="queue-more">
            +{audioQueue.length - (isSingleMode ? 3 : 5)} more notes in queue
          </div>
        )}
      </div>
    </div>
    
    {/* Visualization area - enhanced for single mode */}
    <div className={`visualization-container ${isSingleMode ? 'enhanced-visualization' : ''}`}>
      <div className="waveform-container">
        <canvas ref={canvasRef} className="waveform-canvas" />
      </div>
    </div>
  </div>
);
});

export default VoiceModule;