import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import './DroneChoirPerformer.css';
import VoiceModule from './VoiceModule';
import { startUnison, stopAll } from './performance';
import { queueForVoice } from './droneList';
import { VOICE_RANGES } from './voiceTypes';
import socketManager from './DroneSocketManager';
import { getSocketHttpUrl, getApiHttpUrl } from './socketConfig';
import { io } from 'socket.io-client';

const VOICE_RANGE_MAPPING = {
  drone4: 'soprano',
  drone3: 'alto',
  drone2: 'tenor',
  drone1: 'bass'
};

const PLAYER_PAGE_PARAMS = ['drone1', 'drone2', 'drone3', 'drone4'];
const PLAYER_PAGE_LABELS = ['Drone 1', 'Drone 2', 'Drone 3', 'Drone 4'];

const getInitialSingleVoiceMode = () => {
  const queryParams = new URLSearchParams(window.location.search);
  for (const [rangeParam, voiceType] of Object.entries(VOICE_RANGE_MAPPING)) {
    if (queryParams.has(rangeParam)) {
      return voiceType;
    }
  }
  return null;
};

const DroneChoirPerformer = () => {
  // State for controlling all modules
  const [isAllPlaying, setIsAllPlaying] = useState(false);
  const [soloVoice, setSoloVoice] = useState(null);
  const [singleVoiceMode, setSingleVoiceMode] = useState(getInitialSingleVoiceMode);
  const [isConnected, setIsConnected] = useState(false);
  const [viewMode, setViewMode] = useState(null); // 'controller' or 'viewer'
  const [hostIpDisplay, setHostIpDisplay] = useState(window.location.hostname || '…');
  const [isAwaitingBroadcast, setIsAwaitingBroadcast] = useState(false);

  // Keep latest mode values available to socket listeners (avoid stale closures)
  const viewModeRef = useRef(viewMode);
  const awaitingBroadcastRef = useRef(false);
  const pendingBroadcastNotesRef = useRef(null);
  const sharedAudioContextRef = useRef(null);
  const singleVoiceModeRef = useRef(singleVoiceMode);
  const soloVoiceRef = useRef(soloVoice);
  const lastReceivedStateKeyRef = useRef(null);
  const lastAppliedVoiceKeyRef = useRef(null);
  const performanceEpochRef = useRef(Date.now());
  const performanceStoppedRef = useRef(false);
  const blockPlaysRef = useRef(false);
  const lastStopEpochRef = useRef(0);
  const lastStopAtRef = useRef(0);
  const acceptedPlayEpochRef = useRef(0);
  const pageReloadedRef = useRef(
    typeof performance !== 'undefined'
    && performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload'
  );
  const reloadSnapshotRef = useRef(null);

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    singleVoiceModeRef.current = singleVoiceMode;
  }, [singleVoiceMode]);

  useEffect(() => {
    soloVoiceRef.current = soloVoice;
  }, [soloVoice]);

  // Show this machine's LAN IP on the dashboard for phone connections
  useEffect(() => {
    let cancelled = false;
    const loadHostIp = async () => {
      try {
        const response = await fetch(`${getSocketHttpUrl()}/local-ips`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const ip = Array.isArray(data.ips) && data.ips.length > 0
          ? data.ips[0]
          : (window.location.hostname || 'localhost');
        if (!cancelled) setHostIpDisplay(ip);
      } catch (_) {
        if (!cancelled) {
          setHostIpDisplay(window.location.hostname || 'localhost');
        }
      }
    };

    loadHostIp();
    return () => {
      cancelled = true;
    };
  }, []);
  
  // Stable refs map so hook dependency arrays stay clean
  const sopranoRef = useRef(null);
  const altoRef = useRef(null);
  const tenorRef = useRef(null);
  const bassRef = useRef(null);
  const voiceModuleRefs = useMemo(() => ({
    soprano: sopranoRef,
    alto: altoRef,
    tenor: tenorRef,
    bass: bassRef,
  }), []);

  const performanceSnapshotKey = (epoch, voiceState) => {
    const noteName = voiceState?.currentNote?.note || '';
    const nextName = voiceState?.nextNote?.note || '';
    const queueKey = Array.isArray(voiceState?.queue)
      ? voiceState.queue.map((item) => `${item?.droneId || ''}:${item?.note || ''}`).join('|')
      : '';
    return `${Number(epoch) || 0}|${voiceState?.isPlaying ? '1' : '0'}|${noteName}|${nextName}|${queueKey}`;
  };

  const shouldIgnoreCachedPerformance = (epoch, voiceState) => {
    const snapshot = reloadSnapshotRef.current;
    if (!snapshot || !singleVoiceModeRef.current) return false;

    const incomingEpoch = Number(epoch) || 0;
    if (incomingEpoch > snapshot.epoch) {
      reloadSnapshotRef.current = null;
      return false;
    }

    const key = performanceSnapshotKey(snapshot.epoch, voiceState);
    if (key === snapshot.key) return true;

    reloadSnapshotRef.current = null;
    return false;
  };

  const applyVoiceState = useCallback((voiceType, voiceState) => {
    const activeVoice = singleVoiceModeRef.current;
    if (activeVoice && voiceType !== activeVoice) return;

    const voiceRef = voiceModuleRefs[voiceType]?.current;
    if (!voiceRef || !voiceState) return;

    const noteName = voiceState.currentNote?.note || null;
    const nextName = voiceState.nextNote?.note || null;
    const queueKey = Array.isArray(voiceState.queue)
      ? voiceState.queue.map((item) => `${item?.droneId || ''}:${item?.note || ''}`).join('|')
      : '';
    const incomingKey = `${voiceState.isPlaying ? '1' : '0'}:${noteName || ''}:${nextName || ''}:${queueKey}`;

    try {
      // Honor explicit stops from the dashboard first, even if the payload is a duplicate.
      if (!voiceState.isPlaying) {
        console.log(`Stopping ${voiceType} from dashboard broadcast`);
        voiceRef.stopPerformance?.();
        voiceRef.stopAutoGeneration?.();
        lastAppliedVoiceKeyRef.current = incomingKey;
        return;
      }

      if (blockPlaysRef.current) {
        return;
      }

      if (lastAppliedVoiceKeyRef.current === incomingKey) {
        return;
      }

      if (voiceState.currentNote) {
        // Same current note — still push next-note updates without restarting audio
        const localNote = voiceRef.getCurrentNote?.();
        const localNext = voiceRef.getNextNote?.();
        if (
          voiceRef.isPlaying
          && localNote?.note
          && localNote.note === voiceState.currentNote.note
        ) {
          const incomingNext = voiceState.nextNote || null;
          const incomingQueue = Array.isArray(voiceState.queue) ? voiceState.queue : null;
          if ((localNext?.note || null) !== (incomingNext?.note || null) || incomingQueue) {
            voiceRef.syncToNote?.(voiceState.currentNote, incomingNext, incomingQueue);
          }
          lastAppliedVoiceKeyRef.current = incomingKey;
          return;
        }

        // Mirror the dashboard's current/next note exactly
        if (voiceRef.syncToNote) {
          voiceRef.syncToNote(voiceState.currentNote, voiceState.nextNote || null, voiceState.queue || null);
        } else {
          voiceRef.clearQueue();
          voiceRef.addSpecificNote(voiceState.currentNote);
          if (voiceState.nextNote) {
            voiceRef.addSpecificNote(voiceState.nextNote);
          }
          if (!voiceRef.isPlaying) {
            voiceRef.startPerformance();
          }
        }
        voiceRef.stopAutoGeneration?.();
        lastAppliedVoiceKeyRef.current = incomingKey;
      }
    } catch (error) {
      console.error(`Error applying voice state for ${voiceType}:`, error);
    }
  }, [voiceModuleRefs]);

  const applyReceivedState = useCallback((state) => {
    // singleVoiceMode means this tab is a player page even before registration completes
    const isViewer = viewModeRef.current === 'viewer' || Boolean(singleVoiceModeRef.current);
    if (!state || !isViewer) return;

    const activeVoice = singleVoiceModeRef.current;
    const activeVoiceState = activeVoice ? state.voices?.[activeVoice] : null;
    const noteName = activeVoiceState?.currentNote?.note || null;
    const nextName = activeVoiceState?.nextNote?.note || null;
    const queueKey = Array.isArray(activeVoiceState?.queue)
      ? activeVoiceState.queue.map((item) => `${item?.droneId || ''}:${item?.note || ''}`).join('|')
      : '';
    const incomingKey = `${state.isPlaying ? '1' : '0'}:${activeVoice || 'all'}:${noteName || ''}:${nextName || ''}:${queueKey}`;
    const isStop = !state.isPlaying || (activeVoiceState && !activeVoiceState.isPlaying);
    const epoch = Number(state.epoch) || 0;

    const stateTimestamp = Number(state.timestamp) || 0;

    if (shouldIgnoreCachedPerformance(epoch, activeVoiceState)) {
      console.log('Ignoring cached notes restored after reload');
      return;
    }

    if (!state.isPlaying) {
      if (epoch && acceptedPlayEpochRef.current && epoch < acceptedPlayEpochRef.current) {
        return;
      }
      if (epoch > lastStopEpochRef.current) lastStopEpochRef.current = epoch;
      if (stateTimestamp > lastStopAtRef.current) lastStopAtRef.current = stateTimestamp;
      blockPlaysRef.current = true;
    } else if (blockPlaysRef.current) {
      const staleEpoch = lastStopEpochRef.current > 0 && epoch > 0 && epoch <= lastStopEpochRef.current;
      const newerThanStop = stateTimestamp > lastStopAtRef.current;
      const staleTime = !newerThanStop && (
        lastStopEpochRef.current === 0
          ? (!stateTimestamp || stateTimestamp <= lastStopAtRef.current)
          : staleEpoch
      );
      if ((staleEpoch && !newerThanStop) || staleTime) {
        console.log('Ignoring stale playing state after stop');
        return;
      }
      if (staleEpoch && newerThanStop) lastStopEpochRef.current = 0;
      blockPlaysRef.current = false;
      if (epoch > acceptedPlayEpochRef.current) acceptedPlayEpochRef.current = epoch;
    } else if (epoch > acceptedPlayEpochRef.current) {
      acceptedPlayEpochRef.current = epoch;
    }

    // Ignore duplicate dashboard payloads — except stops, which must always land
    if (!isStop && lastReceivedStateKeyRef.current === incomingKey) {
      return;
    }
    lastReceivedStateKeyRef.current = incomingKey;

    setIsAllPlaying((prev) => (prev === state.isPlaying ? prev : state.isPlaying));
    setSoloVoice((prev) => (prev === state.soloVoice ? prev : state.soloVoice));

    Object.entries(state.voices || {}).forEach(([voiceType, voiceState]) => {
      applyVoiceState(voiceType, voiceState);
    });
  }, [applyVoiceState]);
  
  const broadcastState = useCallback(() => {
    if (viewModeRef.current !== 'controller') return;
    if (performanceStoppedRef.current) return;
    
    const voices = {};
    let anyVoicePlaying = false;
    
    Object.entries(voiceModuleRefs).forEach(([voiceType, ref]) => {
      if (!ref.current) return;
      
      const isVoicePlaying = ref.current.isPlaying || false;
      const currentNote = ref.current.getCurrentNote?.() || null;
      
      if (isVoicePlaying) {
        anyVoicePlaying = true;
      }
      
      voices[voiceType] = {
        isPlaying: isVoicePlaying,
        currentNote: currentNote,
        nextNote: ref.current.getNextNote?.() || null,
        queue: ref.current.getQueue?.() || []
      };
      
      console.log(`${voiceType} state for broadcast:`, isVoicePlaying ? 'playing' : 'stopped', currentNote?.note);
    });
    
    setIsAllPlaying((prev) => (prev === anyVoicePlaying ? prev : anyVoicePlaying));
    
    const state = {
      isPlaying: anyVoicePlaying,
      soloVoice: soloVoiceRef.current,
      voices,
      epoch: performanceEpochRef.current,
      timestamp: Date.now()
    };
    
    console.log("Broadcasting state:", state.isPlaying ? 'playing' : 'stopped', 
                Object.keys(voices).map(v => `${v}: ${voices[v].isPlaying ? 'playing' : 'stopped'}`).join(', '));
    
    socketManager.updateState(state);
  }, [voiceModuleRefs]);

  const broadcastStartedNotes = useCallback((startedNotes) => {
    if (viewModeRef.current !== 'controller' || !startedNotes) return;

    const voices = {};
    Object.entries(VOICE_RANGES).forEach(([voiceType]) => {
      const note = startedNotes[voiceType] || null;
      const testOnly = note?.testOnly === true;
      const nextNote = testOnly ? null : (voiceModuleRefs[voiceType]?.current?.getNextNote?.() || null);
      voices[voiceType] = {
        isPlaying: Boolean(note),
        currentNote: note,
        nextNote,
        queue: testOnly ? [] : (voiceModuleRefs[voiceType]?.current?.getQueue?.() || [])
      };
    });

    const epoch = performanceEpochRef.current;
    const state = {
      isPlaying: Object.values(voices).some((voice) => voice.isPlaying),
      soloVoice: soloVoiceRef.current,
      voices,
      epoch,
      timestamp: Date.now()
    };

    console.log('Broadcasting start-all notes to viewers:',
      Object.keys(voices).map(v => `${v}: ${voices[v].currentNote?.note || 'none'}`).join(', '));

    // Explicit start command so individual players begin audio immediately
    if (typeof socketManager.startVoices === 'function') {
      socketManager.startVoices(startedNotes, epoch);
    } else if (socketManager.socket) {
      socketManager.socket.emit('start-voices', { voices: startedNotes, epoch });
    }
    socketManager.updateState(state);
  }, []);

  const broadcastStoppedVoices = useCallback((voiceTypes = null) => {
    if (viewModeRef.current !== 'controller') return;

    const fullStop = !voiceTypes || voiceTypes.length === 0;
    if (fullStop) {
      performanceStoppedRef.current = true;
      performanceEpochRef.current = Math.max(performanceEpochRef.current + 1, Date.now());
    }
    const epoch = performanceEpochRef.current;

    const voices = {};
    let anyVoicePlaying = false;

    Object.keys(VOICE_RANGES).forEach((voiceType) => {
      const shouldStop = !voiceTypes || voiceTypes.includes(voiceType);
      const ref = voiceModuleRefs[voiceType];
      const isVoicePlaying = shouldStop ? false : Boolean(ref?.current?.isPlaying);
      const currentNote = shouldStop ? null : (ref?.current?.getCurrentNote?.() || null);

      if (isVoicePlaying) {
        anyVoicePlaying = true;
      }

      voices[voiceType] = {
        isPlaying: isVoicePlaying,
        currentNote,
        nextNote: shouldStop ? null : (ref?.current?.getNextNote?.() || null),
        queue: shouldStop ? [] : (ref?.current?.getQueue?.() || [])
      };
    });

    const state = {
      isPlaying: anyVoicePlaying,
      soloVoice: soloVoiceRef.current,
      voices,
      epoch,
      timestamp: Date.now()
    };

    console.log('Broadcasting stop to viewers:',
      Object.keys(voices).map(v => `${v}: ${voices[v].isPlaying ? 'playing' : 'stopped'}`).join(', '));

    if (typeof socketManager.stopVoices === 'function') {
      socketManager.stopVoices(voiceTypes, epoch, fullStop);
    } else if (socketManager.socket) {
      socketManager.socket.emit('stop-voices', { voiceTypes, epoch, fullStop });
    }
    socketManager.updateState(state);
    setIsAllPlaying(anyVoicePlaying);
  }, [voiceModuleRefs]);
  
  // Effect for checking URL query parameters and detecting single voice mode
  useEffect(() => {
    const initialVoice = getInitialSingleVoiceMode();
    if (initialVoice) {
      console.log(`Single voice mode detected: ${initialVoice}`);
      setSingleVoiceMode(initialVoice);
      singleVoiceModeRef.current = initialVoice;
    }
  }, []);
  
  // Connect to socket server and set up listeners
  useEffect(() => {
    socketManager.connect();

    const fallbackTimer = setTimeout(() => {
      if (!socketManager.isConnected) {
        // Single-voice (viewer) pages should never fall back to controller mode —
        // they must stay in viewer mode and wait for the socket server.
        const isSingleVoice = singleVoiceModeRef.current;
        if (isSingleVoice) {
          console.warn(`Socket server unavailable for ${isSingleVoice} viewer — will keep retrying. Start it with: npm run server (port 8080).`);
          // Don't set isConnected or viewMode; Socket.IO will keep reconnecting automatically.
          return;
        }
        console.warn('Socket server unavailable — running in standalone controller mode');
        console.warn('Start it with: npm run server (port 8080). Individual players will not receive notes until it is running.');
        setIsConnected(true);
        setViewMode('controller');
      }
    }, 5000);
    
    const handleConnect = () => setIsConnected(true);
    const handleDisconnect = () => setIsConnected(false);
    const handleRegistered = (data) => {
      viewModeRef.current = data.type;
      setViewMode(data.type);
      const serverEpoch = Number(data?.epoch) || 0;
      if (data?.type === 'controller' && serverEpoch > performanceEpochRef.current) {
        performanceEpochRef.current = serverEpoch;
      }
    };
    const handleInitialState = (state) => {
      const activeVoice = singleVoiceModeRef.current;
      if (pageReloadedRef.current && activeVoice) {
        const voiceState = state?.voices?.[activeVoice] || null;
        reloadSnapshotRef.current = {
          epoch: Number(state?.epoch) || 0,
          at: Date.now(),
          key: performanceSnapshotKey(state?.epoch, voiceState),
        };
        const voiceRef = voiceModuleRefs[activeVoice]?.current;
        voiceRef?.stopPerformance?.();
        voiceRef?.clearQueue?.();
        console.log(`Reload cleared cached queue for ${activeVoice}`);
        return;
      }
      applyReceivedState(state);
    };
    const handleStateUpdated = (state) => applyReceivedState(state);
    const handleVoiceState = (data) => {
      if (
        data?.voiceType
        && data.voiceType === singleVoiceModeRef.current
        && shouldIgnoreCachedPerformance(reloadSnapshotRef.current?.epoch, data.state)
      ) {
        return;
      }
      applyVoiceState(data.voiceType, data.state);
    };
    const handleStartVoices = (payload) => {
      const activeVoice = singleVoiceModeRef.current;
      if (!activeVoice) return;

      const epoch = Number(payload?.epoch) || 0;
      const startedAt = Number(payload?.timestamp) || 0;
      if (reloadSnapshotRef.current && epoch <= reloadSnapshotRef.current.epoch) {
        const snapshotAt = reloadSnapshotRef.current.at || 0;
        if (!startedAt || !snapshotAt || startedAt <= snapshotAt) {
          console.log('Ignoring cached start after reload');
          return;
        }
      }
      reloadSnapshotRef.current = null;
      if (lastStopEpochRef.current > 0 && epoch > 0 && epoch <= lastStopEpochRef.current) {
        if (!(startedAt > lastStopAtRef.current)) {
          console.log('Ignoring stale start-voices after stop');
          return;
        }
        lastStopEpochRef.current = 0;
        blockPlaysRef.current = false;
      }
      if (epoch && acceptedPlayEpochRef.current && epoch < acceptedPlayEpochRef.current) {
        return;
      }
      if (epoch > acceptedPlayEpochRef.current) acceptedPlayEpochRef.current = epoch;
      blockPlaysRef.current = false;

      const note = payload?.voices?.[activeVoice];
      if (!note) return;

      const voiceRef = voiceModuleRefs[activeVoice]?.current;
      if (!voiceRef) return;

      const incomingKey = `1:${note.note || ''}`;
      const localNote = voiceRef.getCurrentNote?.();
      if (
        voiceRef.isPlaying
        && localNote?.note === note.note
      ) {
        lastAppliedVoiceKeyRef.current = incomingKey;
        lastReceivedStateKeyRef.current = `1:${activeVoice}:${note.note || ''}`;
        return;
      }

      console.log(`Start-voices command received for ${activeVoice}:`, note.note);
      if (voiceRef.syncToNote) {
        voiceRef.syncToNote(note, null);
      } else {
        voiceRef.clearQueue?.();
        voiceRef.addSpecificNote?.(note);
        voiceRef.startPerformance?.();
      }
      lastAppliedVoiceKeyRef.current = incomingKey;
      lastReceivedStateKeyRef.current = `1:${activeVoice}:${note.note || ''}`;
    };
    const handleStopVoices = (payload) => {
      const activeVoice = singleVoiceModeRef.current;
      if (!activeVoice) return;

      const voiceTypes = payload?.voiceTypes;
      if (Array.isArray(voiceTypes) && voiceTypes.length > 0 && !voiceTypes.includes(activeVoice)) {
        return;
      }

      const epoch = Number(payload?.epoch) || 0;
      const stoppedAt = Number(payload?.timestamp) || Date.now();
      const allVoices = ['soprano', 'alto', 'tenor', 'bass'];
      const fullStop = payload?.fullStop === true
        || !Array.isArray(voiceTypes)
        || voiceTypes.length === 0
        || allVoices.every((voice) => voiceTypes.includes(voice));
      if (epoch && acceptedPlayEpochRef.current && epoch < acceptedPlayEpochRef.current) {
        return;
      }
      if (fullStop) {
        if (epoch > lastStopEpochRef.current) lastStopEpochRef.current = epoch;
        if (stoppedAt > lastStopAtRef.current) lastStopAtRef.current = stoppedAt;
        blockPlaysRef.current = true;
      }

      console.log(`Stop-voices command received for ${activeVoice}`);
      const voiceRef = voiceModuleRefs[activeVoice]?.current;
      voiceRef?.stopPerformance?.();
      voiceRef?.stopAutoGeneration?.();
      lastAppliedVoiceKeyRef.current = '0:';
      lastReceivedStateKeyRef.current = `0:${activeVoice}:`;
    };

    socketManager.on('connect', handleConnect);
    socketManager.on('disconnect', handleDisconnect);
    socketManager.on('registered', handleRegistered);
    socketManager.on('initial-state', handleInitialState);
    socketManager.on('state-updated', handleStateUpdated);
    socketManager.on('voice-state', handleVoiceState);
    socketManager.on('start-voices', handleStartVoices);
    socketManager.on('stop-voices', handleStopVoices);
    
    return () => {
      clearTimeout(fallbackTimer);
      socketManager.off('connect', handleConnect);
      socketManager.off('disconnect', handleDisconnect);
      socketManager.off('registered', handleRegistered);
      socketManager.off('initial-state', handleInitialState);
      socketManager.off('state-updated', handleStateUpdated);
      socketManager.off('voice-state', handleVoiceState);
      socketManager.off('start-voices', handleStartVoices);
      socketManager.off('stop-voices', handleStopVoices);
      // Keep the shared socket alive across remounts; just detach listeners
    };
  }, [applyReceivedState, applyVoiceState, voiceModuleRefs]);
  
  // Register as controller or viewer when connected
  useEffect(() => {
    if (!isConnected || !socketManager.isConnected) return;
    
    if (singleVoiceMode) {
      socketManager.register('viewer', singleVoiceMode);
    } else {
      socketManager.register('controller');
    }
  }, [isConnected, singleVoiceMode]);
  
  // Broadcast state updates to server (from controller)
  useEffect(() => {
    if (viewMode !== 'controller') return;
    
    const broadcastInterval = setInterval(() => {
      // Only keep-alive while this dashboard is actually playing.
      // Idle controller tabs must not overwrite another session's start.
      if (performanceStoppedRef.current) return;
      const anyPlaying = Object.values(voiceModuleRefs).some(
        (ref) => ref.current && ref.current.isPlaying
      );
      if (anyPlaying) {
        broadcastState();
      }
    }, 1000);
    
    return () => {
      clearInterval(broadcastInterval);
    };
  }, [viewMode, broadcastState, voiceModuleRefs]);

  const handleSoloToggle = useCallback((voiceType, isSolo) => {
    if (viewMode !== 'controller') return;
    
    console.log('Solo toggle called:', { voiceType, isSolo });
    
    if (isSolo) {
      setSoloVoice(voiceType);

      // Ensure only the selected voice is active
      Object.entries(voiceModuleRefs).forEach(([refVoiceType, ref]) => {
        if (ref.current) {
          const isSelected = refVoiceType === voiceType;
          ref.current.setIsSolo(isSelected);
          ref.current.setIsSelected(isSelected);
        }
      });
    } else {
      setSoloVoice(null);

      // Deselect all voice modules
      Object.values(voiceModuleRefs).forEach(ref => {
        if (ref.current) {
          ref.current.setIsSolo(false);
          ref.current.setIsSelected(false);
        }
      });
    }
    
    // Broadcast state after change
    setTimeout(broadcastState, 100);
  }, [viewMode, broadcastState, voiceModuleRefs]);
  
  // Initialize shared audio context for all voice modules
  const initSharedAudioContext = useCallback(() => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!sharedAudioContextRef.current || sharedAudioContextRef.current.state === 'closed') {
      sharedAudioContextRef.current = new Ctx();
    }
    const ctx = sharedAudioContextRef.current;
    // Resume inside the button-click gesture so later broadcasted notes can play
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      ctx.resume().catch((error) => {
        console.warn('Shared AudioContext resume failed:', error);
      });
    }
    return ctx;
  }, []);

  const parseBroadcastNotes = useCallback((payload) => {
    const voices = payload?.data?.voices || payload?.voices || [];
    if (!Array.isArray(voices)) return {};

    const notesByVoice = {};
    voices.forEach((voice) => {
      const voiceType = voice.voice_type || voice.voiceType;
      if (!voiceType || !VOICE_RANGES[voiceType]) return;

      const frequency = Number(voice.frequency);
      if (!Number.isFinite(frequency) || frequency <= 0) return;

      notesByVoice[voiceType] = {
        frequency,
        duration: Number(voice.duration) || 10,
        note: voice.note || '',
        max_gain: voice.max_gain,
      };
    });
    return notesByVoice;
  }, []);

  const applyBroadcastNotes = useCallback((notesByVoice) => {
    if (!notesByVoice || Object.keys(notesByVoice).length === 0) return false;
    if (performanceStoppedRef.current) {
      pendingBroadcastNotesRef.current = notesByVoice;
      return false;
    }

    const ctx = initSharedAudioContext();

    Object.entries(notesByVoice).forEach(([voiceType, note]) => {
      const voiceRef = voiceModuleRefs[voiceType]?.current;
      if (!voiceRef || !note) return;

      voiceRef.stopAutoGeneration?.();

      if (voiceRef.isPlaying && typeof voiceRef.syncToNote === 'function') {
        voiceRef.syncToNote(note, null);
      } else {
        voiceRef.clearQueue?.();
        voiceRef.addSpecificNote?.(note);
        voiceRef.startPerformance?.(ctx, { fromBroadcast: true });
      }
    });

    awaitingBroadcastRef.current = false;
    pendingBroadcastNotesRef.current = null;
    setIsAwaitingBroadcast(false);
    setIsAllPlaying(true);
    broadcastStartedNotes(notesByVoice);
    setTimeout(broadcastState, 200);
    console.log('Applied broadcasted drone notes:',
      Object.keys(notesByVoice).map((v) => `${v}: ${notesByVoice[v].note || notesByVoice[v].frequency}`).join(', '));
    return true;
  }, [initSharedAudioContext, voiceModuleRefs, broadcastStartedNotes, broadcastState]);

  const handleApiInputReceived = useCallback((payload) => {
    const isController = viewModeRef.current === 'controller' && !singleVoiceModeRef.current;
    if (!isController) return;

    const notesByVoice = parseBroadcastNotes(payload);
    if (Object.keys(notesByVoice).length === 0) {
      console.warn('api-input-received had no usable voice notes', payload);
      return;
    }

    if (performanceStoppedRef.current) {
      pendingBroadcastNotesRef.current = notesByVoice;
      console.log('Voices are stopped — holding drone notes until Start');
      return;
    }

    console.log('Broadcasted drone data received — playing now:', notesByVoice);
    applyBroadcastNotes(notesByVoice);
  }, [parseBroadcastNotes, applyBroadcastNotes, voiceModuleRefs]);

  const handleApiInputReceivedRef = useRef(handleApiInputReceived);
  handleApiInputReceivedRef.current = handleApiInputReceived;

  useEffect(() => {
    socketManager.on('api-input-received', handleApiInputReceived);
    return () => {
      socketManager.off('api-input-received', handleApiInputReceived);
    };
  }, [handleApiInputReceived]);

  // Mycelial posts to api-server.js on :3000, which broadcasts api-input-received
  useEffect(() => {
    const apiUrl = getApiHttpUrl();
    console.log('Connecting to API server for drone broadcasts at', apiUrl);
    const apiSocket = io(apiUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
    });

    const onApiInput = (payload) => {
      handleApiInputReceivedRef.current(payload);
    };

    apiSocket.on('connect', () => {
      console.log('Connected to API server for drone-update broadcasts');
    });
    apiSocket.on('connect_error', (error) => {
      console.warn('API server connection error:', error.message);
    });
    apiSocket.on('api-input-received', onApiInput);

    return () => {
      apiSocket.off('api-input-received', onApiInput);
      apiSocket.disconnect();
    };
  }, []);
  
  // Handle start unison button click
  const handleStartUnison = useCallback(() => {
    if (viewModeRef.current !== 'controller') return;

    performanceStoppedRef.current = false;
    performanceEpochRef.current = Math.max(performanceEpochRef.current + 1, Date.now());
    
    startUnison(voiceModuleRefs, initSharedAudioContext, setIsAllPlaying);

    // Push A notes to individual players right away
    const startedNotes = {};
    Object.entries(voiceModuleRefs).forEach(([voiceType, ref]) => {
      if (!ref.current) return;
      const voiceRange = VOICE_RANGES[voiceType];
      startedNotes[voiceType] = {
        frequency: voiceRange.hertz,
        duration: 10,
        note: voiceRange.note,
        testOnly: true,
      };
    });
    broadcastStartedNotes(startedNotes);
    setTimeout(broadcastState, 200);
  }, [initSharedAudioContext, broadcastStartedNotes, broadcastState, voiceModuleRefs]);
  
  // Handle start all button click — queue every drone in order, then play from 1
  const handleStartAll = useCallback(() => {
    if (viewModeRef.current !== 'controller') return;

    const ctx = initSharedAudioContext();
    let loaded = false;

    performanceStoppedRef.current = false;
    performanceEpochRef.current = Math.max(performanceEpochRef.current + 1, Date.now());
    awaitingBroadcastRef.current = false;
    pendingBroadcastNotesRef.current = null;
    setIsAwaitingBroadcast(false);

    Object.keys(VOICE_RANGES).forEach((voiceType) => {
      const queue = queueForVoice(voiceType);
      const voiceRef = voiceModuleRefs[voiceType]?.current;
      if (!voiceRef || queue.length === 0) return;

      voiceRef.loadQueue?.(queue);
      voiceRef.startPerformance?.(ctx, { fromBroadcast: true });
      loaded = true;
    });

    if (!loaded) {
      console.warn('Drone list has no playable notes');
      return;
    }

    setIsAllPlaying(true);
    setTimeout(broadcastState, 200);
    console.log('Start All Voices queued drones in order');
  }, [initSharedAudioContext, voiceModuleRefs, broadcastState]);
  
  // Handle stop all button click
  const handleStopAll = useCallback(() => {
    if (viewModeRef.current !== 'controller') return;

    performanceStoppedRef.current = true;
    awaitingBroadcastRef.current = false;
    pendingBroadcastNotesRef.current = null;
    setIsAwaitingBroadcast(false);

    // Silence every dashboard voice, then tell player pages to stop and stay stopped.
    stopAll(voiceModuleRefs, setIsAllPlaying);
    broadcastStoppedVoices();
  }, [broadcastStoppedVoices, voiceModuleRefs]);

  const handlePlayStateChange = useCallback((voiceType, isPlaying) => {
    if (viewModeRef.current !== 'controller') return;

    if (!isPlaying) {
      const anyStillPlaying = Object.values(voiceModuleRefs).some(
        (ref) => ref.current && ref.current.isPlaying
      );

      if (!anyStillPlaying) {
        setIsAllPlaying(false);
        // Only broadcast a stop when every voice on this dashboard has stopped
        broadcastStoppedVoices();
      } else {
        // One voice stopped, others still going — push partial state
        broadcastStoppedVoices([voiceType]);
      }
      return;
    }

    if (performanceStoppedRef.current) {
      performanceStoppedRef.current = false;
      performanceEpochRef.current = Math.max(performanceEpochRef.current + 1, Date.now());
    }
    setTimeout(broadcastState, 100);
  }, [broadcastState, broadcastStoppedVoices, voiceModuleRefs]);
  
  const handleCurrentNoteChange = useCallback((_voiceType, _note) => {
    if (viewModeRef.current !== 'controller') return;
    // Push the new active note to individual players right away
    broadcastState();
  }, [broadcastState]);
  
  // Keep all dashboard voices at full output level

  useEffect(() => {
    if (singleVoiceMode) return undefined;
    Object.values(voiceModuleRefs).forEach((ref) => {
      ref.current?.setVolume?.(1);
    });
    return undefined;
  }, [singleVoiceMode, voiceModuleRefs]);

  const getRangeLabel = (voiceType) => {
    return VOICE_RANGES[voiceType]?.label || 'Drone';
  };
  
  // If in single voice mode, render only that voice module
  if (singleVoiceMode && VOICE_RANGES[singleVoiceMode]) {
    const voiceType = singleVoiceMode;
    const range = VOICE_RANGES[voiceType];
    const rangeLabel = getRangeLabel(voiceType);
    
    return (
      <div className="drone-choir-single">
        <h1>{rangeLabel}</h1>
        <div className="single-voice-container">
          <VoiceModule 
            key={voiceType}
            voiceType={voiceType} 
            voiceRange={range}
            rangeLabel={rangeLabel}
            ref={voiceModuleRefs[voiceType]}
            onPlayStateChange={(isPlaying) => {
              // Only controller can change play state
              if (viewMode !== 'controller') return;
              
              // Broadcast state after change
              setTimeout(broadcastState, 100);
            }}
            onSoloToggle={handleSoloToggle}
            isSoloMode={false}
            isCurrentSolo={false}
            isViewerMode={true}
            isSingleMode={true}
          />
        </div>
      </div>
    );
  }
  
  // If not connected yet, show connecting message
  if (!isConnected) {
    return (
      <div className="connecting-message">
        <h2>Connecting to server...</h2>
      </div>
    );
  }

  // Regular full view with all voice modules
  return (
    <div className="drone-choir-multi">
      {/* Master controls */}
      <div className="master-controls">
        <h2 className="dashboard-ip-heading">
          Players: http://{hostIpDisplay}:{window.location.port || '3000'}/{' '}
          {PLAYER_PAGE_PARAMS.map((param, index) => {
            const port = window.location.port || '3000';
            const href = `http://${hostIpDisplay}:${port}/?${param}`;
            return (
              <React.Fragment key={param}>
                {index > 0 && ' · '}
                <a
                  className="dashboard-player-link"
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {PLAYER_PAGE_LABELS[index]}
                </a>
              </React.Fragment>
            );
          })}
        </h2>
        {isAwaitingBroadcast && (
          <p className="waiting-broadcast-status">
            Voices armed. Waiting for mycelial notes…
          </p>
        )}
        <div className="master-control-pair">
          <button 
            className={`master-control-button start${isAwaitingBroadcast ? ' waiting' : ''}`}
            onClick={handleStartAll}
            disabled={isAllPlaying || isAwaitingBroadcast || viewMode !== 'controller'}
          >
            {isAwaitingBroadcast ? 'Waiting for notes…' : 'Start All Voices'}
          </button>
          <button 
            className="master-control-button stop" 
            onClick={handleStopAll}
            disabled={viewMode !== 'controller'}
          >
            Stop All Voices
          </button>
        </div>
        <button 
          className="master-control-button initial" 
          onClick={handleStartUnison}
          disabled={isAllPlaying || isAwaitingBroadcast || viewMode !== 'controller'}
        >
          Test
        </button>
      </div>
      
      {/* Voice modules grid */}
      <div className="voice-modules-grid">
        {Object.entries(VOICE_RANGES).map(([voiceType, range]) => (
          <VoiceModule 
            key={voiceType}
            voiceType={voiceType} 
            voiceRange={range}
            rangeLabel={getRangeLabel(voiceType)}
            ref={voiceModuleRefs[voiceType]}
            onPlayStateChange={(isPlaying) => handlePlayStateChange(voiceType, isPlaying)}
            onCurrentNoteChange={handleCurrentNoteChange}
            onSoloToggle={handleSoloToggle}
            isSoloMode={soloVoice !== null}
            isCurrentSolo={soloVoice === voiceType}
            isViewerMode={viewMode === 'viewer'}
          />
        ))}
      </div>
    </div>
  );
};

export default DroneChoirPerformer;