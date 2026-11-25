const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { networkInterfaces } = require('os');

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

// Allow localhost + private LAN origins (phones opening via machine IP)
const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(
    origin
  );
};

const io = socketIo(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked origin: ${origin}`));
      }
    },
    methods: ['GET', 'POST'],
  },
});

// CORS for Express HTTP routes (Socket.IO CORS does not cover these)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/drone-update', (req, res) => {
  const data = req.body || {};
  const voices = Array.isArray(data.voices) ? data.voices : [];
  const payload = {
    timestamp: new Date().toISOString(),
    source: 'python-api',
    data: { voices },
  };

  console.log(
    'Drone update received:',
    voices.map((v) => `${v.voice_type || v.voiceType}:${v.note || v.frequency}`).join(', ') || 'none'
  );

  io.emit('api-input-received', payload);

  res.status(200).json({
    status: 'success',
    message: 'Drone sound data received and broadcast',
  });
});

app.get('/local-ips', (_req, res) => {
  res.json({
    hostname: require('os').hostname(),
    ips: getLocalIPs(),
  });
});

const createInitialState = () => ({
  isPlaying: false,
  voices: {
    soprano: { isPlaying: false, currentNote: null, nextNote: null },
    alto: { isPlaying: false, currentNote: null, nextNote: null },
    tenor: { isPlaying: false, currentNote: null, nextNote: null },
    bass: { isPlaying: false, currentNote: null, nextNote: null },
  },
});

let currentState = createInitialState();
let lastStopEpoch = 0;
let lastPlayEpoch = 0;
let lastStopAt = 0;
let lastPlayAt = 0;

// A reloaded dashboard starts its epoch counter over. A later wall-clock
// time still means this start is new, even when the epoch number is smaller.
const playingEventIsStale = (epoch, timestamp) => {
  const incomingEpoch = Number(epoch) || 0;
  const incomingAt = Number(timestamp) || 0;
  const epochStale = Boolean(lastStopEpoch) && incomingEpoch <= lastStopEpoch;
  if (!epochStale) return false;
  if (incomingAt && incomingAt > lastStopAt) {
    lastStopEpoch = 0;
    return false;
  }
  return true;
};

const buildStateFromNotes = (notesByVoice, isPlaying = true) => {
  const voices = {};
  ['soprano', 'alto', 'tenor', 'bass'].forEach((voiceType) => {
    const note = notesByVoice?.[voiceType] || null;
    voices[voiceType] = {
      isPlaying: Boolean(isPlaying && note),
      currentNote: isPlaying ? note : null,
      nextNote: null,
    };
  });

  return {
    isPlaying: Object.values(voices).some((voice) => voice.isPlaying),
    soloVoice: null,
    voices,
    timestamp: Date.now(),
  };
};

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('register', (data) => {
    console.log('Client registered:', data);

    socket.leave('controllers');
    socket.leave('viewers');

    if (data.type === 'controller') {
      socket.join('controllers');
      socket.data.role = 'controller';
      socket.emit('registration-success', {
        type: 'controller',
        epoch: Math.max(lastPlayEpoch, lastStopEpoch),
      });
    } else if (data.type === 'viewer') {
      socket.join('viewers');
      socket.data.role = 'viewer';
      socket.data.voiceType = data.voiceType || null;
      socket.emit('registration-success', {
        type: 'viewer',
        voiceType: data.voiceType || null,
        initialState: currentState,
      });
    }
  });

  socket.on('state-update', (newState) => {
    const epoch = Number(newState?.epoch) || 0;
    const timestamp = Number(newState?.timestamp) || 0;
    if (newState?.isPlaying) {
      if (playingEventIsStale(epoch, timestamp)) {
        console.log('Ignoring stale playing state after stop', epoch, lastStopEpoch);
        return;
      }
      if (epoch) lastPlayEpoch = Math.max(lastPlayEpoch, epoch);
      if (timestamp) lastPlayAt = Math.max(lastPlayAt, timestamp);
    } else if (
      (epoch && lastPlayEpoch && epoch < lastPlayEpoch)
      || (timestamp && lastPlayAt && timestamp < lastPlayAt)
    ) {
      console.log('Ignoring stale stopped state', epoch, lastPlayEpoch);
      return;
    } else {
      if (epoch) lastStopEpoch = epoch;
      if (timestamp) lastStopAt = timestamp;
    }

    currentState = newState;
    console.log(
      'State update:',
      newState?.isPlaying ? 'playing' : 'stopped',
      Object.keys(newState?.voices || {})
        .map((v) => `${v}:${newState.voices[v]?.isPlaying ? newState.voices[v]?.currentNote?.note || 'on' : 'off'}`)
        .join(', ')
    );
    io.to('viewers').emit('state-updated', newState);
  });

  // Explicit start command from dashboard → all individual players
  socket.on('start-voices', (payload = {}) => {
    const epoch = Number(payload.epoch) || 0;
    const timestamp = Number(payload.timestamp) || Date.now();
    if (playingEventIsStale(epoch, timestamp)) {
      console.log('Ignoring stale start-voices after stop', epoch, lastStopEpoch);
      return;
    }
    if (epoch) lastPlayEpoch = Math.max(lastPlayEpoch, epoch);
    if (timestamp) lastPlayAt = Math.max(lastPlayAt, timestamp);

    const notes = payload.voices || payload.notes || {};
    currentState = buildStateFromNotes(notes, true);
    currentState.epoch = epoch;
    currentState.timestamp = Date.now();
    console.log(
      'Start voices command:',
      Object.keys(notes).map((v) => `${v}:${notes[v]?.note || '?'}`).join(', ')
    );
    io.to('viewers').emit('start-voices', {
      voices: notes,
      epoch,
      timestamp: currentState.timestamp,
    });
    io.to('viewers').emit('state-updated', currentState);
  });

  socket.on('stop-voices', (payload = {}) => {
    const epoch = Number(payload.epoch) || 0;
    const timestamp = Number(payload.timestamp) || 0;
    const fullStop = payload.fullStop === true || !payload.voiceTypes;
    if (
      (epoch && lastPlayEpoch && epoch < lastPlayEpoch)
      || (timestamp && lastPlayAt && timestamp < lastPlayAt)
    ) {
      console.log('Ignoring stale stop-voices', epoch, lastPlayEpoch);
      return;
    }
    if (fullStop && epoch) {
      lastStopEpoch = epoch;
      if (timestamp) lastStopAt = timestamp;
    }

    const voiceTypes = payload.voiceTypes || null;
    if (!voiceTypes || fullStop) {
      currentState = createInitialState();
      currentState.epoch = epoch || lastStopEpoch;
    } else {
      voiceTypes.forEach((voiceType) => {
        if (currentState.voices[voiceType]) {
          currentState.voices[voiceType] = {
            isPlaying: false,
            currentNote: null,
            nextNote: null,
          };
        }
      });
      currentState.isPlaying = Object.values(currentState.voices).some((v) => v.isPlaying);
      currentState.epoch = epoch;
      currentState.timestamp = Date.now();
    }

    console.log('Stop voices command:', voiceTypes ? voiceTypes.join(',') : 'all');
    const stopPayload = {
      voiceTypes: voiceTypes || ['soprano', 'alto', 'tenor', 'bass'],
      fullStop,
      epoch: epoch || lastStopEpoch,
      timestamp: Date.now(),
    };
    // Broadcast to every connected page, not only the viewers room
    io.emit('stop-voices', stopPayload);
    io.emit('state-updated', currentState);
  });

  socket.on('request-voice-state', (voiceType) => {
    if (currentState.voices[voiceType]) {
      socket.emit('voice-state', {
        voiceType,
        state: currentState.voices[voiceType],
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const getLocalIPs = () => {
  try {
    const nets = networkInterfaces();
    const results = [];

    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          results.push(net.address);
        }
      }
    }

    return results;
  } catch (error) {
    console.warn('Could not enumerate network interfaces:', error.message);
    return [];
  }
};

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Socket.IO server running on port ${PORT}`);

  const localIPs = getLocalIPs();
  if (localIPs.length > 0) {
    console.log('\nAccess URLs:');
    localIPs.forEach((ip) => {
      console.log(`http://${ip}:${PORT}`);
    });
  }
});
