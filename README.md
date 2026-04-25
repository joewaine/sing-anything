# Sing All The Time

Upload any song, the app stems it with Demucs, detects phrases, and drops you into the same practice-with-pitch-feedback UI as [Sing Beatles](../sing-beatles/). Native (iOS + Android) via Expo.

**Status**: not yet scaffolded. See [CLAUDE.md](./CLAUDE.md) for the full build plan — start there.

## Quick picture

```
you drop in a song
        ↓
demucs splits it into drums/bass/vocals/other
        ↓
whisperx transcribes the vocals with word-level timestamps
        ↓
pitch tracker turns those words into MIDI-ish notes
        ↓
phrase detector slices the song into practicable 10–20s chunks
        ↓
you're in the Sing Beatles practice UI, but for your song
```

## Starting a build session

Open this folder in Claude Code and say *"read CLAUDE.md and propose a plan."* The doc points the agent at the two reference projects (`../sing-beatles/` and `../demucs/`) so they don't start from zero.

## Sibling projects

- `../sing-beatles/` — the UI we're cloning. Don't modify it.
- `../demucs/` — the stemming reference app.
