/**
 * Build a PCM WAV Blob for a short tone.
 * HTML5 Audio + blob URL is the most reliable phone unlock/play path.
 */
export const PLAYBACK_FADE_SECONDS = 1.5;
export const STOP_FADE_SECONDS = 5;

export function buildToneWavBlob(frequency = 440, durationSec = 2, sampleRate = 22050, envelope = null) {
  const numFrames = Math.max(1, Math.floor(sampleRate * durationSec));
  const dataBytes = numFrames * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < numFrames; i += 1) {
    const t = i / sampleRate;
    const defaultFade = Math.min(PLAYBACK_FADE_SECONDS, durationSec / 2);
    const fadeInSeconds = envelope ? envelope.fadeIn : defaultFade;
    const fadeOutSeconds = envelope ? envelope.fadeOut : defaultFade;
    const fadeIn = !fadeInSeconds || fadeInSeconds <= 0 ? 1 : Math.min(1, t / fadeInSeconds);
    const fadeOut = !fadeOutSeconds || fadeOutSeconds <= 0 ? 1 : Math.min(1, (durationSec - t) / fadeOutSeconds);
    const env = fadeIn * fadeOut;
    // Harmonics so tiny phone speakers can actually reproduce it
    const sample =
      (Math.sin(2 * Math.PI * frequency * t) * 0.75
        + Math.sin(2 * Math.PI * frequency * 2 * t) * 0.4
        + Math.sin(2 * Math.PI * frequency * 3 * t) * 0.22)
      * env;
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clipped * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export function buildToneWavObjectUrl(frequency = 440, durationSec = 2) {
  return URL.createObjectURL(buildToneWavBlob(frequency, durationSec));
}

// Full level at the start, silence at the end. Used when Stop replaces a phone clip.
export function buildFadeOutWavObjectUrl(frequency = 440, fadeSeconds = STOP_FADE_SECONDS) {
  const seconds = Math.max(0.05, fadeSeconds);
  return URL.createObjectURL(buildToneWavBlob(frequency, seconds, 22050, {
    fadeIn: 0,
    fadeOut: seconds,
  }));
}
