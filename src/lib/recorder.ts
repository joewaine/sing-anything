import { Platform } from 'react-native';
import { Audio } from 'expo-av';

export interface Recorder {
  prepare(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<string>;
  /** The live mic MediaStream, for Web Audio tap-in (waveform analyser etc.). */
  getStream(): MediaStream | null;
}

// MIME types in priority order. Chromium + Firefox take the first; iOS Safari
// only speaks mp4 (AAC), so we probe down the list with isTypeSupported.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // Some old browsers throw on isTypeSupported — skip.
    }
  }
  return '';
}

function friendlyGetUserMediaError(err: unknown): Error {
  const name =
    err && typeof err === 'object' && 'name' in err
      ? String((err as { name: unknown }).name)
      : '';
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';

  // iOS + other browsers block mic on non-HTTPS origins (except localhost).
  const isSecure =
    typeof window === 'undefined'
      ? true
      : window.isSecureContext ||
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1';

  if (!isSecure) {
    return new Error(
      'Microphone requires HTTPS. Open this page via the deployed URL (not over a LAN IP).',
    );
  }
  if (name === 'NotAllowedError' || /not allowed|denied/i.test(msg)) {
    return new Error(
      'Microphone permission denied. Tap the lock icon in the address bar and allow microphone access, then reload.',
    );
  }
  if (name === 'NotFoundError' || /no.*microphone|no.*device/i.test(msg)) {
    return new Error('No microphone detected on this device.');
  }
  if (name === 'NotSupportedError' || /not supported/i.test(msg)) {
    return new Error(
      'Audio recording is not supported in this browser. Try Chrome, Safari 14.5+, or Firefox.',
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

class WebRecorder implements Recorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private mimeType = '';

  async prepare(): Promise<void> {
    if (this.mediaRecorder && this.stream) return;
    this.chunks = [];

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support audio capture.');
    }

    // Aggressive constraints to escape Android Chrome's default
    // VOICE_COMMUNICATION audio pipeline, which downsamples the mic to 16 kHz
    // and applies destructive AGC/EC/NS. Each knob nudges a different browser:
    //   - sampleRate/channelCount/latency: standard Media Capture hints; push
    //     Chrome into a music-capture path.
    //   - googEchoCancellation etc: Chrome-specific legacy constraints that
    //     disable the WebRTC voice pipeline even when the standard hints are
    //     ignored. Harmless on Firefox / Safari.
    // `ideal` so iOS/Safari don't outright reject; if the device can't honor,
    // it'll pick the closest match instead of failing.
    const strictConstraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
        sampleRate: { ideal: 48000 },
        channelCount: { ideal: 1 },
        latency: { ideal: 0.01 },
        googEchoCancellation: false,
        googEchoCancellation2: false,
        googAutoGainControl: false,
        googAutoGainControl2: false,
        googNoiseSuppression: false,
        googNoiseSuppression2: false,
        googHighpassFilter: false,
        googTypingNoiseDetection: false,
        googAudioMirroring: false,
      } as unknown as MediaTrackConstraints,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(strictConstraints);
    } catch {
      // Some Android devices reject the strict set outright. Fall back to the
      // default so the user can at least record — quality may be phone-call
      // grade but we'd rather have degraded audio than no audio.
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e2) {
        throw friendlyGetUserMediaError(e2);
      }
    }

    // Log what the device actually gave us so we can diagnose bad-quality
    // reports: if sampleRate comes back as 16000, the OS forced voice mode and
    // no encoder setting will salvage it.
    const track = this.stream.getAudioTracks()[0];
    if (track && typeof track.getSettings === 'function') {
      const s = track.getSettings();
      // eslint-disable-next-line no-console
      console.info('[recorder] mic settings', {
        sampleRate: s.sampleRate,
        channelCount: s.channelCount,
        echoCancellation: s.echoCancellation,
        autoGainControl: (s as unknown as { autoGainControl?: boolean }).autoGainControl,
        noiseSuppression: (s as unknown as { noiseSuppression?: boolean }).noiseSuppression,
      });
    }

    this.mimeType = pickMimeType();
    try {
      this.mediaRecorder = new MediaRecorder(
        this.stream,
        this.mimeType ? { mimeType: this.mimeType } : undefined,
      );
    } catch (e) {
      // Tear down the stream we just acquired so we don't leak the mic.
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      throw friendlyGetUserMediaError(e);
    }

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
  }

  async start(): Promise<void> {
    if (!this.mediaRecorder) await this.prepare();
    this.chunks = [];
    this.mediaRecorder!.start();
  }

  async stop(): Promise<string> {
    return new Promise((resolve, reject) => {
      const mr = this.mediaRecorder;
      if (!mr) return reject(new Error('not recording'));
      mr.onstop = () => {
        const type = this.mimeType || mr.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        const url = URL.createObjectURL(blob);
        this.stream?.getTracks().forEach((t) => t.stop());
        resolve(url);
      };
      mr.stop();
    });
  }

  getStream(): MediaStream | null {
    return this.stream;
  }
}

class NativeRecorder implements Recorder {
  private recording: Audio.Recording | null = null;

  async prepare(): Promise<void> {
    if (this.recording) return;
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) throw new Error('Microphone permission denied');
    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    this.recording = rec;
  }

  async start(): Promise<void> {
    if (!this.recording) await this.prepare();
    await this.recording!.startAsync();
  }

  async stop(): Promise<string> {
    if (!this.recording) throw new Error('not recording');
    await this.recording.stopAndUnloadAsync();
    const uri = this.recording.getURI();
    this.recording = null;
    return uri ?? '';
  }

  getStream(): MediaStream | null {
    return null; // expo-av on native doesn't expose the raw stream
  }
}

export function createRecorder(): Recorder {
  return Platform.OS === 'web' ? new WebRecorder() : new NativeRecorder();
}
