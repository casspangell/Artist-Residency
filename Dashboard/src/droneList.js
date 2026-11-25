import droneList from './sound_files.json';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const VOICE_TYPES = ['soprano', 'alto', 'tenor', 'bass'];

export function noteToFrequency(note) {
  if (!note || typeof note !== 'string') return null;
  const match = note.trim().match(/^([A-G]#?)(-?\d+)$/);
  if (!match) return null;

  const index = NOTE_NAMES.indexOf(match[1]);
  const octave = Number(match[2]);
  if (index < 0 || !Number.isFinite(octave)) return null;

  const midi = (octave + 1) * 12 + index;
  return Math.round(440 * (2 ** ((midi - 69) / 12)) * 100) / 100;
}

export function notesForDrone(droneId) {
  const entry = droneList?.[String(droneId)];
  if (!entry) return null;

  const duration = Number(entry.duration_seconds) || 10;
  const maxGain = Number(entry.max_gain);
  const notesByVoice = {};

  VOICE_TYPES.forEach((voiceType) => {
    const note = entry[voiceType];
    const frequency = noteToFrequency(note);
    if (!note || !frequency) return;

    notesByVoice[voiceType] = {
      frequency,
      duration,
      note,
      max_gain: Number.isFinite(maxGain) ? Math.max(0, Math.min(1, maxGain)) : 0.9,
    };
  });

  return Object.keys(notesByVoice).length > 0 ? notesByVoice : null;
}

export function orderedDroneIds() {
  return Object.keys(droneList)
    .filter((id) => notesForDrone(id))
    .sort((a, b) => Number(a) - Number(b));
}

export function queueForVoice(voiceType) {
  return orderedDroneIds()
    .map((id) => {
      const note = notesForDrone(id)?.[voiceType];
      if (!note) return null;
      return { ...note, droneId: String(id) };
    })
    .filter(Boolean);
}

export default droneList;
