# Ear Trainer

A hands-free ear trainer for musicians. Press **Start**, put the phone in your pocket and listen: the app plays a question, leaves a bar of silence to think, then speaks the answer aloud and shows it on screen.

It is a set of static HTML pages with no build step, no dependencies and no server. It is designed for Safari on iPhone. Add it to the Home Screen and launch it from there: that way it keeps playing with the screen locked, while in a regular Safari tab iOS may stop the sound on lock.

## Trainers

### Intervals

Two notes are played and you name the interval between them, from a minor second up to an octave.

- Choose which of the 12 intervals take part.
- Mode: melodic (one note after the other), harmonic (both together) or mixed.
- Direction for melodic intervals: ascending, descending or mixed.

### Scale degrees

A drone holds the tonic in two octaves. A note is played over it and you name its scale degree, out of all 12 chromatic ones (1, ♭2, 2, ♭3, 3, 4, ♯4, 5, ♭6, 6, ♭7, 7).

- Choose which of the 12 degrees take part.
- Each question goes: a bar of the drone alone, a bar with the note, a bar to think, the answer, then the note once more. The drone never stops.
- Key: random (the drone moves to another key every 8 questions) or any fixed key.

### Chords

A chord is played and you name its quality.

- 33 chord types: triads, seventh chords, sixths, added-tone, altered and extended chords. The first 12 (triads and seventh chords) are enabled by default.
- Mode: block chord, arpeggio or mixed.
- Inversion: root position, 1st, 2nd, 3rd or random. With random inversions the voice also names the inversion. Chords that sound identical to another enabled chord in some inversion (for example, sus2 in 2nd inversion and sus4 in root position) are then played in root position only, so every question has one answer.

### Progressions

A chord progression in a major key is played several times in a row (four by default) and you name the scale degrees (I, ii, iii, IV, V, vi, vii°).

- Key: any of the 12 major keys, or random.
- Length: 1 to 16 bars, one chord per bar, in 4/4.
- Source: a collection of common progressions, randomly generated ones, or both.
- Optionally keep the same progression and only change the key.
- Chords are root-position triads, played as alternating eighth notes: chord, bass, chord, bass.

## Common settings

Every trainer has:

- **Tempo** (30–240 bpm, default 80), which sets the note lengths and pauses.
- **Repeats** (1–8): how many times in a row the question is played before the pause. The default is 4, and 1 for scale degrees.
- **Replay after answer**: plays the question once more after the answer.

All settings can be changed while the trainer is running and are remembered per trainer in the browser.

Notes stay between E2 and E5, a range chosen so that you can sing along with what you hear.

## Running

Open `index.html` in a browser. The pages work straight from the file system, so no web server is needed.

To use it on a phone, host the repository on any static hosting (for example GitHub Pages) and open the URL in Safari. Deploy `index.html`, the trainer pages, `sw.js` and the whole `assets/` folder. Then add the page to the Home Screen (Share → Add to Home Screen) and launch it from the icon, so that playback continues with the screen locked.

Once opened online, the hosted version is cached by a service worker and keeps working without a network connection. When online it always loads the latest deployed version.

## Project structure

```
index.html            menu
intervals.html        one page per trainer: markup and trainer logic
chords.html
progressions.html
degrees.html
assets/
  css/common.css      shared styles
  js/common.js        shared engine: audio, voice, Start/Stop loop, tempo, settings
  voice/*.js          generated voice answers, one file per trainer
sw.js                 service worker: offline cache
make-voice.sh         regenerates the voice files
```

Sound is synthesized with the Web Audio API. Spoken answers are pre-recorded and embedded in the voice files as base64, so nothing is fetched at runtime.

## Regenerating the voice

Voice files are generated on macOS with the built-in `say` and `afconvert` tools:

```sh
./make-voice.sh intervals          # or: chords, progressions, degrees
./make-voice.sh chords Daniel      # with another system voice
```

The default voice is Samantha; run `say -v '?'` to list the available ones. The phrases for each trainer are defined inside the script.
