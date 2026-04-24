export type MidiNote = {
  start_ms: number;
  end_ms: number;
  pitch_midi: number;
  lyric: string;
};

export type SongStatus = 'queued' | 'stemming' | 'analyzing' | 'ready' | 'error';

export type Song = {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  artist: string | null;
  duration_ms: number | null;
  original_path: string;
  status: SongStatus;
  error: string | null;
  created_at: string;
};

export type PhraseType = 'line' | 'verse';

export type Phrase = {
  id: string;
  song_id: string;
  user_id: string;
  slug: string;
  phrase_type: PhraseType;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  tempo_bpm: number | null;
  lyric_text: string | null;
  notes: MidiNote[];
  vocals_path: string;
  backing_path: string | null;
};

export type Attempt = {
  id: string;
  user_id: string;
  phrase_id: string;
  audio_path: string;
  pitch_analysis: unknown | null;
  feedback_text: string | null;
  feedback_try: string | null;
  created_at: string;
};

export type JobStage =
  | 'upload'
  | 'stemming'
  | 'whisper'
  | 'pitch'
  | 'slicing'
  | 'done'
  | 'error';

export type Job = {
  id: string;
  user_id: string;
  song_id: string | null;
  stage: JobStage;
  progress: number | null;
  message: string | null;
  updated_at: string;
};
