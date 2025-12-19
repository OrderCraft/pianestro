// Pianestro - MIDI Piano Visualizer
// Script for v2 UI

// DOM Elements
const midiStatusElement = document.getElementById('statusText');
const statusIndicator = document.querySelector('.status-indicator');
const pianoKeyboard = document.getElementById('pianoKeyboard');
const pianoRollCanvas = document.getElementById('pianoRollCanvas');

// MIDI State
let midiAccess = null;
let midiOutput = null; // Port to send MIDI back to piano
let activeNotes = new Set();

// Piano Roll State
let pianoRollCtx = null;
let noteHistory = [];
let animationFrameId = null;

// Mode State
let currentMode = 'freeplay'; // 'freeplay' or 'lesson'
// Lesson State
let lessonStartTime = null;
let lessonActive = false;
let lessonPaused = false;
let lessonPausedTime = 0; // Total time spent paused
let lessonPauseStartTime = null;
let waitingNotes = new Set(); // The notes we're waiting for (Set of MIDI numbers)
let currentEventIndex = 0; // Track which event we're on

// Dynamic Lesson State (loaded from MIDI files)
let currentLessonEvents = null;  // Will be populated from MIDI file
let lessonDuration = 0;          // Total lesson duration in milliseconds
let lessonName = "No lesson loaded";
let lessonDescription = "";

// Audio State
let pianoSynth = null;
let isAudioInitialized = false;

/**
 * Initialize Audio (Tone.js)
 * Must be called after user interaction
 */
async function initAudio() {
    if (isAudioInitialized) return;

    // Show loading status
    const uploadStatus = document.getElementById('uploadStatus');
    const originalText = uploadStatus ? uploadStatus.textContent : '';
    if (uploadStatus) uploadStatus.textContent = 'Завантаження звуків піаніно...';

    await Tone.start();
    console.log('🔊 Audio Context started');

    // Use Sampler with Salamander Grand Piano samples
    pianoSynth = new Tone.Sampler({
        urls: {
            "A0": "A0.mp3",
            "C1": "C1.mp3",
            "D#1": "Ds1.mp3",
            "F#1": "Fs1.mp3",
            "A1": "A1.mp3",
            "C2": "C2.mp3",
            "D#2": "Ds2.mp3",
            "F#2": "Fs2.mp3",
            "A2": "A2.mp3",
            "C3": "C3.mp3",
            "D#3": "Ds3.mp3",
            "F#3": "Fs3.mp3",
            "A3": "A3.mp3",
            "C4": "C4.mp3",
            "D#4": "Ds4.mp3",
            "F#4": "Fs4.mp3",
            "A4": "A4.mp3",
            "C5": "C5.mp3",
            "D#5": "Ds5.mp3",
            "F#5": "Fs5.mp3",
            "A5": "A5.mp3",
            "C6": "C6.mp3",
            "D#6": "Ds6.mp3",
            "F#6": "Fs6.mp3",
            "A6": "A6.mp3",
            "C7": "C7.mp3",
            "D#7": "Ds7.mp3",
            "F#7": "Fs7.mp3",
            "A7": "A7.mp3",
            "C8": "C8.mp3"
        },
        release: 1,
        baseUrl: "https://tonejs.github.io/audio/salamander/"
    }).toDestination();

    // Set volume
    pianoSynth.volume.value = -5;

    // Wait for samples to load
    await Tone.loaded();

    console.log('🎹 Piano samples loaded!');
    if (uploadStatus) uploadStatus.textContent = originalText || 'Готово';

    isAudioInitialized = true;
}

/**
 * Play a note sound if audio is initialized
 * @param {number} midiNumber - MIDI note number
 * @param {number} durationMs - Duration in ms
 * @param {boolean} isLeftHand - True for Left Hand, False for Right Hand
 */
function playNoteSound(midiNumber, durationMs, isLeftHand = false) {
    if (!isAudioInitialized || !pianoSynth) return;

    // Convert MIDI to Frequency or Note Name
    const noteName = Tone.Frequency(midiNumber, "midi").toNote();
    const durationSec = durationMs / 1000;

    // Play Browser Audio
    pianoSynth.triggerAttackRelease(noteName, durationSec);

    // Play Physical Piano (MIDI Output)
    if (midiOutput) {
        // Standard Yamaha/Casio Light Guide channels:
        // Right Hand = Channel 1 (0) -> 0x90
        // Left Hand = Channel 2 (1) -> 0x91
        const channel = isLeftHand ? 1 : 0;
        sendMidiNote(midiNumber, 100, durationMs, channel);
    }
}

/**
 * Send MIDI Note to external device
 * @param {number} note - MIDI note number
 * @param {number} velocity - Velocity (0-127)
 * @param {number} durationMs - Note duration
 * @param {number} channel - MIDI Channel (0-15). Default 0 (Channel 1)
 */
function sendMidiNote(note, velocity, durationMs, channel = 0) {
    if (!midiOutput) return;

    // Constrain channel 0-15
    const ch = Math.max(0, Math.min(15, channel));

    // Note On status byte = 0x90 + channel
    const noteOnStatus = 0x90 + ch;
    // Note Off status byte = 0x80 + channel
    const noteOffStatus = 0x80 + ch;

    // [Status, Note, Velocity]
    midiOutput.send([noteOnStatus, note, velocity]);

    // Schedule Note Off
    setTimeout(() => {
        try {
            midiOutput.send([noteOffStatus, note, 0]);
        } catch (e) {
            console.warn("Could not send MIDI NoteOff", e);
        }
    }, durationMs);
}

// Piano keyboard configuration
const PIANO_CONFIG = {
    startNote: 21,  // A0
    endNote: 108,   // C8
    totalKeys: 88,
    whiteKeyWidth: 25,
    blackKeyWidth: 18
};

// Hand Control Configuration
const SPLIT_POINT = 60; // Middle C (C4) divides Left vs Right hand
let leftHandActive = true;
let rightHandActive = true;

/**
 * Piano key pattern: which keys in an octave are black
 * true = black key, false = white key
 * Pattern: C, C#, D, D#, E, F, F#, G, G#, A, A#, B
 */
const BLACK_KEY_PATTERN = [false, true, false, true, false, false, true, false, true, false, true, false];

/**
 * Note names for labeling
 */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Get note name from MIDI number
 */
function getNoteNameFromMidi(midiNumber) {
    const octave = Math.floor(midiNumber / 12) - 1;
    const noteName = NOTE_NAMES[midiNumber % 12];
    return `${noteName}${octave}`;
}

/**
 * Check if a note is a black key
 */
function isBlackKey(midiNumber) {
    return BLACK_KEY_PATTERN[midiNumber % 12];
}

/**
 * Generate piano keyboard
 */
function generatePianoKeyboard() {
    pianoKeyboard.innerHTML = '';

    let whiteKeyIndex = 0;
    const whiteKeyWidth = 25;

    for (let i = PIANO_CONFIG.startNote; i <= PIANO_CONFIG.endNote; i++) {
        const isBlack = isBlackKey(i);
        const noteName = getNoteNameFromMidi(i);

        const key = document.createElement('div');
        key.className = `piano-key ${isBlack ? 'black' : 'white'}`;
        key.dataset.note = i;
        key.dataset.noteName = noteName;

        // Add label
        const label = document.createElement('span');
        label.className = 'key-label';
        label.textContent = noteName;
        key.appendChild(label);

        if (isBlack) {
            // Position black keys between white keys
            const prevNoteIndex = i - 1;
            const prevIsBlack = isBlackKey(prevNoteIndex);

            // Calculate position based on the white key to the left
            const leftPosition = (whiteKeyIndex * whiteKeyWidth) - 8;
            key.style.left = `${leftPosition}px`;
        } else {
            // White keys are positioned normally
            whiteKeyIndex++;
        }

        // Add click event for future interactivity
        key.addEventListener('mousedown', () => activateKey(i));
        key.addEventListener('mouseup', () => deactivateKey(i));
        key.addEventListener('mouseleave', () => deactivateKey(i));

        pianoKeyboard.appendChild(key);
    }
}

/**
 * Activate a piano key visually and trigger note logic
 */
function activateKey(midiNumber, velocity = 90, fromMIDI = false) {
    const key = pianoKeyboard.querySelector(`[data-note="${midiNumber}"]`);
    if (key) {
        key.classList.add('active');
        activeNotes.add(midiNumber);

        // If not from MIDI (i.e., from mouse click), trigger the same logic
        if (!fromMIDI) {
            handleNoteOn(midiNumber, velocity);
        }
    }
}

/**
 * Deactivate a piano key visually and trigger note-off logic
 */
function deactivateKey(midiNumber, fromMIDI = false) {
    const key = pianoKeyboard.querySelector(`[data-note="${midiNumber}"]`);
    if (key) {
        key.classList.remove('active');
        activeNotes.delete(midiNumber);

        // If not from MIDI (i.e., from mouse release), trigger the same logic
        if (!fromMIDI) {
            handleNoteOff(midiNumber);
        }
    }
}

/**
 * Initialize Piano Roll Canvas
 */
function initPianoRoll() {
    pianoRollCtx = pianoRollCanvas.getContext('2d');
    resizePianoRoll();

    // Start animation loop
    animatePianoRoll();
}

/**
 * Resize piano roll canvas
 */
function resizePianoRoll() {
    const wrapper = document.querySelector('.piano-roll-wrapper');
    const dpr = window.devicePixelRatio || 1;

    pianoRollCanvas.width = wrapper.offsetWidth * dpr;
    pianoRollCanvas.height = wrapper.offsetHeight * dpr;

    pianoRollCtx.scale(dpr, dpr);
}

/**
 * Get X position for a note on the piano roll
 */
function getNoteXPosition(midiNumber) {
    const noteIndex = midiNumber - PIANO_CONFIG.startNote;
    let whiteKeyCount = 0;

    // Count white keys before this note
    for (let i = PIANO_CONFIG.startNote; i < midiNumber; i++) {
        if (!isBlackKey(i)) {
            whiteKeyCount++;
        }
    }

    const isBlack = isBlackKey(midiNumber);

    if (isBlack) {
        // Black keys are positioned between white keys
        return (whiteKeyCount * PIANO_CONFIG.whiteKeyWidth) - 8 + (PIANO_CONFIG.blackKeyWidth / 2);
    } else {
        // White keys
        return (whiteKeyCount * PIANO_CONFIG.whiteKeyWidth) + (PIANO_CONFIG.whiteKeyWidth / 2);
    }
}

/**
 * Get width for a note on the piano roll
 */
function getNoteWidth(midiNumber) {
    return isBlackKey(midiNumber) ? PIANO_CONFIG.blackKeyWidth : PIANO_CONFIG.whiteKeyWidth;
}

/**
 * Add note to piano roll history
 */
function addNoteToRoll(midiNumber, velocity) {
    noteHistory.push({
        note: midiNumber,
        velocity: velocity,
        y: 0, // Start at bottom (will be drawn from bottom)
        timestamp: Date.now()
    });
}

/**
 * Load and parse MIDI file for lesson
 */
async function loadLessonFromMidi(file) {
    const uploadStatus = document.getElementById('uploadStatus');
    const lessonStartBtn = document.getElementById('lessonStartBtn');

    try {
        uploadStatus.textContent = 'Завантаження...';
        uploadStatus.classList.remove('loaded', 'error');

        // Read file as ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();

        // Parse MIDI file using Tone.js Midi library
        const midi = new Midi(arrayBuffer);

        if (!midi || !midi.tracks || midi.tracks.length === 0) {
            throw new Error('MIDI файл не містить треків');
        }

        // Extract all note events from all tracks
        const PREPARATION_TIME_MS = 5000; // 5 seconds preparation
        const COOLDOWN_TIME_MS = 3000;    // 3 seconds cooldown

        // Extract all note events from all tracks to find the earliest start time
        const rawNotes = [];

        midi.tracks.forEach(track => {
            // Determine hand from track name
            let hand = null;
            // track.name might be undefined in some cases
            const trackName = (track.name || '').toLowerCase();

            if (trackName.includes('left')) {
                hand = 'left';
            } else if (trackName.includes('right')) {
                hand = 'right';
            }

            console.log(`Track: "${track.name}" -> Hand: ${hand}`);

            track.notes.forEach(note => {
                rawNotes.push({
                    midi: note.midi,
                    time: note.time,
                    duration: note.duration,
                    velocity: note.velocity,
                    hand: hand // Store determined hand
                });
            });
        });

        if (rawNotes.length === 0) {
            throw new Error('MIDI файл не містить нот');
        }

        // Find the start time of the very first note
        // This allows us to "trim" silence at the beginning of the MIDI file
        const minTime = Math.min(...rawNotes.map(n => n.time));

        const allNoteEvents = [];

        rawNotes.forEach(note => {
            // Normalize time: subtract minTime so the first note starts at 0
            // Then convert to milliseconds and add preparation time
            const normalizedTime = note.time - minTime;
            const timeMs = Math.round(normalizedTime * 1000) + PREPARATION_TIME_MS;
            const durationMs = Math.round(note.duration * 1000);
            const midiNote = note.midi;
            const velocity = Math.round(note.velocity * 127);

            // Add NoteOn event
            allNoteEvents.push({
                action: 'NoteOn',
                note: midiNote,
                timeMs: timeMs,
                noteName: getNoteNameFromMidi(midiNote),
                velocity: velocity,
                durationMs: durationMs,
                hand: note.hand // Pass hand property
            });

            // Add NoteOff event
            allNoteEvents.push({
                timeMs: timeMs + durationMs,
                action: 'NoteOff',
                note: midiNote,
                noteName: getNoteNameFromMidi(midiNote)
            });
        });

        // Sort events by time
        allNoteEvents.sort((a, b) => a.timeMs - b.timeMs);

        if (allNoteEvents.length === 0) {
            throw new Error('MIDI файл не містить нот');
        }

        // Calculate lesson duration (last event time + cooldown)
        const lastEventTime = allNoteEvents[allNoteEvents.length - 1].timeMs;
        lessonDuration = lastEventTime + COOLDOWN_TIME_MS;

        // Store lesson data
        currentLessonEvents = allNoteEvents;
        lessonName = file.name.replace(/\.mid$/i, '');
        lessonDescription = `${midi.tracks.length} треків, ${allNoteEvents.filter(e => e.action === 'NoteOn').length} нот`;

        // Update UI
        uploadStatus.textContent = `✓ ${lessonName}`;
        uploadStatus.classList.add('loaded');
        lessonStartBtn.disabled = false;

        console.log('✅ MIDI файл завантажено:', lessonName);
        console.log(`📊 Події: ${allNoteEvents.length}, Тривалість: ${(lessonDuration / 1000).toFixed(1)}s`);

    } catch (error) {
        console.error('❌ Помилка завантаження MIDI:', error);
        uploadStatus.textContent = `✗ Помилка: ${error.message}`;
        uploadStatus.classList.add('error');
        lessonStartBtn.disabled = true;
        currentLessonEvents = null;
        lessonDuration = 0;
    }
}

/**
 * Draw piano roll lanes (vertical lines matching keys)
 */
function drawPianoRollLanes() {
    const wrapper = document.querySelector('.piano-roll-wrapper');
    const width = wrapper.offsetWidth;
    const height = wrapper.offsetHeight;

    pianoRollCtx.clearRect(0, 0, width, height);

    // Draw vertical lanes for each key
    for (let i = PIANO_CONFIG.startNote; i <= PIANO_CONFIG.endNote; i++) {
        const x = getNoteXPosition(i);
        const isBlack = isBlackKey(i);

        if (isBlackKey(i)) continue;

        // Draw lane line
        pianoRollCtx.strokeStyle = isBlack ? 'rgba(0, 0, 0, 0.05)' : 'rgba(0, 0, 0, 0.08)';
        pianoRollCtx.lineWidth = 1;
        pianoRollCtx.beginPath();
        pianoRollCtx.moveTo(x - getNoteWidth(i) / 2, 0);
        pianoRollCtx.lineTo(x - getNoteWidth(i) / 2, height);
        pianoRollCtx.stroke();
    }
}

/**
 * Draw notes on piano roll
 */
function drawNotes() {
    const wrapper = document.querySelector('.piano-roll-wrapper');
    const height = wrapper.offsetHeight;

    if (currentMode === 'lesson' && lessonActive && currentLessonEvents) {
        // Draw lesson expected notes
        // Calculate elapsed time accounting for pauses
        let elapsedTime;
        if (lessonPaused) {
            elapsedTime = lessonPauseStartTime - lessonStartTime - lessonPausedTime;
        } else {
            elapsedTime = Date.now() - lessonStartTime - lessonPausedTime;
        }

        currentLessonEvents.forEach((event, index) => {
            if (event.action === 'NoteOn') {
                // Use stored duration
                const duration = event.durationMs;
                const timeUntilNote = event.timeMs - elapsedTime;

                // Calculate Y position (notes come from top)
                // noteY represents the Leading Edge (bottom of note block)
                const pixelsPerMs = 100 / 1000;
                const noteY = height - (timeUntilNote * pixelsPerMs);
                const noteHeight = duration * pixelsPerMs;

                // Determine Hand
                let isLeftHand;
                if (event.hand === 'left') {
                    isLeftHand = true;
                } else if (event.hand === 'right') {
                    isLeftHand = false;
                } else {
                    // Fallback to split point
                    isLeftHand = event.note < SPLIT_POINT;
                }
                const isHandActive = isLeftHand ? leftHandActive : rightHandActive;

                // Check for pause: when Leading Edge reaches bottom (height)
                // We only check this for the current event to avoid multiple triggers
                if (!lessonPaused && noteY >= height && index === currentEventIndex) {
                    if (isHandActive) {
                        // Hand is Active -> PAUSE and Wait
                        console.log('🛑 Pause Triggered by:', getNoteNameFromMidi(event.note));
                        lessonPaused = true;
                        lessonPauseStartTime = Date.now();
                        waitingNotes.clear();

                        // Identify Chakra/Chord Loop
                        // Scan current and future notes to find all satisfying the chord window
                        const baseTime = event.timeMs;

                        // We iterate from the current index forward
                        for (let i = index; i < currentLessonEvents.length; i++) {
                            const chordNote = currentLessonEvents[i];
                            if (chordNote.action !== 'NoteOn') continue;

                            // Check time window (50ms tolerance)
                            if (Math.abs(chordNote.timeMs - baseTime) < 50) {
                                // Check if this chord note belongs to an active hand
                                let chordIsLeft;
                                if (chordNote.hand === 'left') {
                                    chordIsLeft = true;
                                } else if (chordNote.hand === 'right') {
                                    chordIsLeft = false;
                                } else {
                                    chordIsLeft = chordNote.note < SPLIT_POINT;
                                }

                                if ((chordIsLeft && leftHandActive) || (!chordIsLeft && rightHandActive)) {
                                    // Add to waiting set
                                    waitingNotes.add(chordNote.note);
                                    console.log(`   + Added to chord: ${getNoteNameFromMidi(chordNote.note)}`);
                                }
                            } else {
                                if (chordNote.timeMs > baseTime + 50) break;
                            }
                        }

                        if (waitingNotes.size === 0) {
                            lessonPaused = false;
                            lessonPauseStartTime = null;
                        }

                    } else {
                        // Hand is DISABLED -> Auto-play / Skip
                        // Find next NoteOn event
                        console.log('⏩ Skipping disabled hand note:', getNoteNameFromMidi(event.note));

                        // PLAY SOUND for the disabled note
                        // Pass hand information for channel routing
                        const handForSound = (event.hand === 'left' || event.hand === 'right')
                            ? (event.hand === 'left')
                            : (event.note < SPLIT_POINT);

                        playNoteSound(event.note, event.durationMs, handForSound);

                        let nextIndex = currentEventIndex + 1;
                        while (nextIndex < currentLessonEvents.length) {
                            if (currentLessonEvents[nextIndex].action === 'NoteOn') {
                                break;
                            }
                            nextIndex++;
                        }
                        currentEventIndex = nextIndex;
                    }
                }

                // Draw if visible
                // Visible range: Bottom > 0 AND Top < height
                if (noteY > 0 && noteY - noteHeight < height) {
                    const x = getNoteXPosition(event.note);
                    const width = getNoteWidth(event.note);
                    const isBlack = isBlackKey(event.note);

                    // Colors based on Hand and Key Type
                    let baseR, baseG, baseB;
                    let fillStyle, strokeStyle;

                    // Only pulse if it's the specific note waiting at the bottom
                    // noteY is the bottom edge of the note. 'height' is the canvas bottom.
                    const isAtHitLine = noteY >= height - 20;

                    if (isLeftHand) {
                        // Left Hand - YELLOWS
                        if (isBlack) {
                            // Darker Yellow/Gold for Black Keys
                            // RGB(234, 179, 8) #EAB308
                            baseR = 234; baseG = 179; baseB = 8;
                            strokeStyle = '#CA8A04'; // Darker border
                        } else {
                            // Lighter Yellow for White Keys
                            // RGB(253, 224, 71) #FDE047
                            baseR = 253; baseG = 224; baseB = 71;
                            strokeStyle = '#EAB308';
                        }
                    } else {
                        // Right Hand - BLUES
                        if (isBlack) {
                            // Darker Blue for Black Keys
                            // RGB(37, 99, 235) #2563EB
                            baseR = 37; baseG = 99; baseB = 235;
                            strokeStyle = '#1D4ED8';
                        } else {
                            // Lighter Blue for White Keys
                            // RGB(96, 165, 250) #60A5FA
                            baseR = 96; baseG = 165; baseB = 250;
                            strokeStyle = '#2563EB';
                        }
                    }

                    // Pulse Logic or Solid Color
                    if (waitingNotes.has(event.note) && lessonPaused && isAtHitLine) {
                        // Pulse: Interpolate towards White
                        const t = 0.4 + 0.4 * Math.sin(Date.now() / 150);

                        // Mix base color with white
                        const r = Math.round(baseR + (255 - baseR) * t);
                        const g = Math.round(baseG + (255 - baseG) * t);
                        const b = Math.round(baseB + (255 - baseB) * t);

                        fillStyle = `rgb(${r}, ${g}, ${b})`;
                        strokeStyle = '#ffffff'; // White border when pulsing
                    } else {
                        // Standard solid color
                        fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
                    }

                    // Draw Rounded Rectangle
                    pianoRollCtx.fillStyle = fillStyle;
                    pianoRollCtx.strokeStyle = strokeStyle;
                    pianoRollCtx.lineWidth = waitingNotes.has(event.note) ? 3 : 1;

                    pianoRollCtx.beginPath();
                    if (pianoRollCtx.roundRect) {
                        pianoRollCtx.roundRect(
                            x - width / 2,
                            noteY - noteHeight,
                            width - 2,
                            noteHeight,
                            6 // radius
                        );
                    } else {
                        // Fallback for older browsers
                        pianoRollCtx.rect(
                            x - width / 2,
                            noteY - noteHeight,
                            width - 2,
                            noteHeight
                        );
                    }
                    pianoRollCtx.fill();
                    pianoRollCtx.stroke();
                }
            }
        });
    }

    // Draw user played notes (in both modes)
    noteHistory.forEach(note => {
        const x = getNoteXPosition(note.note);
        const width = getNoteWidth(note.note);
        const isBlack = isBlackKey(note.note);

        // Calculate opacity based on velocity
        const opacity = 0.3 + (note.velocity / 127) * 0.7;

        // Color based on key type
        const color = isBlack
            ? `rgba(99, 102, 241, ${opacity})`
            : `rgba(139, 92, 246, ${opacity})`;

        // Draw note rectangle
        pianoRollCtx.fillStyle = color;
        pianoRollCtx.fillRect(
            x - width / 2,
            height - note.y - 4,
            width - 2,
            4
        );
    });
}

/**
 * Animate piano roll (notes scroll upward)
 */
function animatePianoRoll() {
    drawPianoRollLanes();

    // Check if lesson is complete
    if (currentMode === 'lesson' && lessonActive && lessonStartTime) {
        const totalElapsedTime = Date.now() - lessonStartTime - lessonPausedTime;

        if (totalElapsedTime >= lessonDuration) {
            // Lesson completed! Reset everything
            console.log('🎉 Lesson completed!');
            lessonActive = false;
            lessonStartTime = null;
            lessonPaused = false;
            lessonPausedTime = 0;
            lessonPauseStartTime = null;
            waitingNotes.clear();
            currentEventIndex = 0;
            noteHistory = [];

            // Reset button
            const lessonStartBtn = document.getElementById('lessonStartBtn');
            lessonStartBtn.innerHTML = '<span class="btn-icon">▶️</span><span class="btn-label">Старт уроку</span>';
        }
    }

    // Update note positions (scroll upward)
    const currentTime = Date.now();
    noteHistory.forEach(note => {
        const elapsed = (currentTime - note.timestamp) / 1000; // seconds
        note.y = elapsed * 100; // 100 pixels per second
    });

    // Remove notes that scrolled off screen
    const wrapper = document.querySelector('.piano-roll-wrapper');
    const height = wrapper.offsetHeight;
    noteHistory = noteHistory.filter(note => note.y < height + 10);

    drawNotes();

    // Continue animation
    animationFrameId = requestAnimationFrame(animatePianoRoll);
}

/**
 * Update MIDI status display
 */
function updateMIDIStatus(message, type = 'loading') {
    midiStatusElement.textContent = message;

    statusIndicator.classList.remove('connected', 'error');

    if (type === 'success') {
        statusIndicator.classList.add('connected');
    } else if (type === 'error') {
        statusIndicator.classList.add('error');
    }
}

/**
 * Check if the correct notes are pressed to resume the lesson (Sequential/Cumulative Test Mode)
 */
function checkLessonProgress() {
    if (currentMode !== 'lesson' || !lessonActive || !lessonPaused || waitingNotes.size === 0) {
        return;
    }

    // Check active notes against waiting notes
    // Sequential Logic: If a correct note is pressed, remove it from the waiting list.
    // We don't require them to be held simultaneously.
    for (const note of activeNotes) {
        if (waitingNotes.has(note)) {
            console.log(`✨ Correct note pressed: ${getNoteNameFromMidi(note)}`);
            waitingNotes.delete(note);
        }
    }

    // If no more notes are waiting, resume lesson
    if (waitingNotes.size === 0) {
        console.log(`✅ All chord notes satisfied! Resuming lesson...`);

        // Resume the lesson
        if (lessonPauseStartTime) {
            lessonPausedTime += (Date.now() - lessonPauseStartTime);
        }
        lessonPaused = false;
        lessonPauseStartTime = null;

        // Move to next NoteOn event (skipping simultaneous ones we just played)
        const currentEventTime = currentLessonEvents[currentEventIndex].timeMs;
        for (let i = currentEventIndex; i < currentLessonEvents.length; i++) {
            // Find the next group of notes that is LATER than current group
            // (Use tolerance to skip all notes in the current chord)
            if (currentLessonEvents[i].timeMs > currentEventTime + 50) {
                // Find start of NEXT group
                for (let j = i; j < currentLessonEvents.length; j++) {
                    if (currentLessonEvents[j].action === 'NoteOn') {
                        currentEventIndex = j;
                        return;
                    }
                }
                break;
            }
        }
    }
}

/**
 * Rewind the lesson by a specified amount (in milliseconds)
 */
function rewindLesson(ms) {
    if (!lessonActive || !currentLessonEvents) return;

    // Calculate current elapsed time
    let elapsedTime;
    if (lessonPaused) {
        elapsedTime = lessonPauseStartTime - lessonStartTime - lessonPausedTime;
    } else {
        elapsedTime = Date.now() - lessonStartTime - lessonPausedTime;
    }

    // Calculate target time (ensure it doesn't go below 0)
    const targetTimeMs = Math.max(0, elapsedTime - ms);
    console.log(`⏩ Rewinding to: ${targetTimeMs}ms (cur: ${elapsedTime}ms)`);

    // We adjust lessonPausedTime to effectively "reset" the start time anchor
    // Higher lessonPausedTime = Lower elapsedTime
    // (Date.now() - lessonStartTime - newPausedTime) = targetTimeMs
    // newPausedTime = Date.now() - lessonStartTime - targetTimeMs

    lessonPausedTime = Date.now() - lessonStartTime - targetTimeMs;

    // Reset lesson state
    lessonPaused = false;
    lessonPauseStartTime = null;
    waitingNotes.clear();

    // Recalculate currentEventIndex
    // We need to find the first event where timeMs >= targetTimeMs
    let newIndex = 0;
    for (let i = 0; i < currentLessonEvents.length; i++) {
        if (currentLessonEvents[i].timeMs >= targetTimeMs) {
            newIndex = i;
            break;
        }
    }
    currentEventIndex = newIndex;

    console.log(`📍 New event index for lesson: ${currentEventIndex}`);
}

/**
 * Handle note-on event (from MIDI or virtual piano)
 */
function handleNoteOn(noteNumber, velocity) {
    // Only add to piano roll visualization in freeplay mode
    if (currentMode === 'freeplay') {
        addNoteToRoll(noteNumber, velocity);
    }

    console.log(`🎹 Note ON: ${getNoteNameFromMidi(noteNumber)} (${noteNumber}) - Velocity: ${velocity}`);

    // NAVIGATION: A0 (MIDI 21) rewinds the lesson by 5 seconds
    if (noteNumber === 21 && lessonActive && currentMode === 'lesson') {
        console.log('⏮️ Rewind triggered by A0');
        rewindLesson(5000); // 5 seconds
        return; // Don't process as a playable note
    }

    // Check progress on every note press
    checkLessonProgress();
}

/**
 * Handle note-off event (from MIDI or virtual piano)
 */
function handleNoteOff(noteNumber) {
    console.log(`🎹 Note OFF: ${getNoteNameFromMidi(noteNumber)} (${noteNumber})`);
    // Also check progress on note off, although we strictly require holding keys to resume
    // This function call is kept for consistency if we change logic later
}

/**
 * Handle incoming MIDI messages
 */
function onMIDIMessage(message) {
    const [command, noteNumber, velocity] = message.data;

    const isNoteOn = command === 144 && velocity > 0;
    const isNoteOff = command === 128 || (command === 144 && velocity === 0);

    if (isNoteOn) {
        activateKey(noteNumber, velocity, true); // fromMIDI = true
        handleNoteOn(noteNumber, velocity);
    } else if (isNoteOff) {
        deactivateKey(noteNumber, true); // fromMIDI = true
        handleNoteOff(noteNumber);
    }
}

/**
 * Starts listening to a MIDI input port.
 */
function startLoggingMIDIInput(input) {
    input.onmidimessage = onMIDIMessage;
    console.log(`🔌 Listening to: ${input.name}`);
}

/**
 * Initialize MIDI
 */
function onMIDISuccess(midi) {
    midiAccess = midi;

    // Auto-select first input
    if (midiAccess.inputs.size > 0) {
        const input = midiAccess.inputs.values().next().value;
        startLoggingMIDIInput(input);
        updateMIDIStatus(`Підключено: ${input.name}`, 'success');
    } else {
        updateMIDIStatus('Пристрій не знайдено', 'error');
    }

    // Auto-select first output for playback
    if (midiAccess.outputs.size > 0) {
        midiOutput = midiAccess.outputs.values().next().value;
        console.log(`🎹 MIDI Output initialized: ${midiOutput.name}`);
    }

    // Handle connection changes
    midiAccess.onstatechange = (event) => {
        const port = event.port;
        console.log(`🔄 MIDI device ${port.state}: ${port.name}`);

        if (port.state === 'connected') {
            if (port.type === 'input') {
                startLoggingMIDIInput(port);
                updateMIDIStatus(`${port.name}`, 'success');
            } else if (port.type === 'output') {
                midiOutput = port;
                console.log(`🎹 MIDI Output initialized: ${midiOutput.name}`);
            }
        } else if (port.state === 'disconnected') {
            if (port.type === 'input') {
                const remainingInputs = Array.from(midiAccess.inputs.values());
                if (remainingInputs.length === 0) {
                    updateMIDIStatus('Пристрій відключено', 'error');
                }
            } else if (port.type === 'output' && midiOutput && midiOutput.id === port.id) {
                midiOutput = null;
                console.log(`🎹 MIDI Output disconnected`);
            }
        }
    };
}

/**
 * Handle MIDI failure
 */
function onMIDIFailure(error) {
    console.error('❌ MIDI Access failed:', error);
    updateMIDIStatus('Помилка доступу до MIDI', 'error');
}

/**
 * Initialize application
 */
function init() {
    console.log('🚀 Initializing Pianestro...');

    // Generate piano keyboard
    generatePianoKeyboard();

    // Initialize piano roll
    initPianoRoll();
    window.addEventListener('resize', resizePianoRoll);

    // Handle window resize
    window.addEventListener('resize', () => {
        resizePianoRoll();
    });

    // Configuration buttons
    const leftHandBtn = document.getElementById('leftHandBtn');
    const rightHandBtn = document.getElementById('rightHandBtn');
    const resetBtn = document.getElementById('resetBtn');
    const modeBtn = document.getElementById('modeBtn');
    const modeLabel = document.getElementById('modeLabel');
    const lessonStartBtn = document.getElementById('lessonStartBtn');

    // Toggle buttons
    leftHandBtn.addEventListener('click', () => {
        leftHandBtn.classList.toggle('active');
        leftHandActive = leftHandBtn.classList.contains('active');
        console.log('Left hand:', leftHandActive ? 'ON' : 'OFF');

        // If paused and we just disabled the waiting hand, we might need to resume?
        // For simplicity, user should toggle before or during flow. 
        // If stuck, they can toggle off and play any note or reset.
        // Actually, let's auto-check progress if we toggle off a hand while waiting.
        if (lessonPaused) checkLessonProgress();
    });

    rightHandBtn.addEventListener('click', () => {
        rightHandBtn.classList.toggle('active');
        rightHandActive = rightHandBtn.classList.contains('active');
        console.log('Right hand:', rightHandActive ? 'ON' : 'OFF');
        if (lessonPaused) checkLessonProgress();
    });

    // Reset button
    resetBtn.addEventListener('click', () => {
        console.log('Reset clicked');
        noteHistory = [];
        if (lessonActive) {
            lessonActive = false;
            lessonStartTime = null;
            lessonPaused = false;
            lessonPausedTime = 0;
            lessonPauseStartTime = null;
            waitingNotes.clear();
            currentEventIndex = 0;
            lessonStartBtn.innerHTML = '<span class="btn-icon">▶️</span><span class="btn-label">Старт уроку</span>';
        }
    });

    // Mode toggle button
    const midiUploadContainer = document.getElementById('midiUploadContainer');

    modeBtn.addEventListener('click', () => {
        if (currentMode === 'freeplay') {
            currentMode = 'lesson';
            modeLabel.textContent = 'Режим уроку';
            modeBtn.classList.remove('active');
            midiUploadContainer.style.display = 'flex';
            lessonStartBtn.style.display = 'flex';
            console.log('Switched to Lesson Mode');
        } else {
            currentMode = 'freeplay';
            modeLabel.textContent = 'Вільна гра';
            modeBtn.classList.add('active');
            midiUploadContainer.style.display = 'none';
            lessonStartBtn.style.display = 'none';
            lessonActive = false;
            lessonStartTime = null;
            console.log('Switched to Free Play Mode');
        }
        noteHistory = [];
    });

    // Lesson start button
    lessonStartBtn.addEventListener('click', async () => {
        if (!lessonActive) {
            // Check if lesson is loaded
            if (!currentLessonEvents || currentLessonEvents.length === 0) {
                console.warn('⚠️ Спочатку завантажте MIDI файл!');
                return;
            }

            // Initialize Audio on first user interaction
            await initAudio();

            // Start lesson
            lessonActive = true;
            lessonStartTime = Date.now();
            lessonPaused = false;
            lessonPausedTime = 0;
            lessonPauseStartTime = null;
            waitingForNote = null;
            currentEventIndex = 0;
            noteHistory = [];
            lessonStartBtn.innerHTML = `<span class="btn-label"><svg width="20px" height="20px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
 <path d="M3 7.8C3 6.11984 3 5.27976 3.32698 4.63803C3.6146 4.07354 4.07354 3.6146 4.63803 3.32698C5.27976 3 6.11984 3 7.8 3H16.2C17.8802 3 18.7202 3 19.362 3.32698C19.9265 3.6146 20.3854 4.07354 20.673 4.63803C21 5.27976 21 6.11984 21 7.8V16.2C21 17.8802 21 18.7202 20.673 19.362C20.3854 19.9265 19.9265 20.3854 19.362 20.673C18.7202 21 17.8802 21 16.2 21H7.8C6.11984 21 5.27976 21 4.63803 20.673C4.07354 20.3854 3.6146 19.9265 3.32698 19.362C3 18.7202 3 17.8802 3 16.2V7.8Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
 </svg></span>`;
            console.log('Lesson started:', lessonName);
        } else {
            // Stop lesson
            lessonActive = false;
            lessonStartTime = null;
            lessonPaused = true;
            lessonPausedTime = 0;
            lessonPauseStartTime = null;
            waitingNotes.clear();
            currentEventIndex = 0;
            lessonStartBtn.innerHTML = `<span class="btn-label"><svg width="20px" height="20px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                < path d = "M5 4.98951C5 4.01835 5 3.53277 5.20249 3.2651C5.37889 3.03191 5.64852 2.88761 5.9404 2.87018C6.27544 2.85017 6.67946 3.11953 7.48752 3.65823L18.0031 10.6686C18.6708 11.1137 19.0046 11.3363 19.1209 11.6168C19.2227 11.8621 19.2227 12.1377 19.1209 12.383C19.0046 12.6635 18.6708 12.886 18.0031 13.3312L7.48752 20.3415C6.67946 20.8802 6.27544 21.1496 5.9404 21.1296C5.64852 21.1122 5.37889 20.9679 5.20249 20.7347C5 20.467 5 19.9814 5 19.0103V4.98951Z" stroke = "currentColor" stroke - width="2" stroke - linecap="round" stroke - linejoin="round" />
 </svg ></span >`;
            console.log('Lesson stopped');
        }
    });

    // MIDI File Upload
    const midiFileInput = document.getElementById('midiFileInput');
    midiFileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            loadLessonFromMidi(file);
        }
    });

    // Request MIDI access
    if (navigator.requestMIDIAccess) {
        updateMIDIStatus('Підключення...', 'loading');

        navigator.requestMIDIAccess()
            .then(onMIDISuccess)
            .catch(onMIDIFailure);
    } else {
        updateMIDIStatus('Web MIDI API не підтримується', 'error');
        console.error('❌ Web MIDI API not supported');
    }
}

// Start application
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
