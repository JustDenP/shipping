import * as Tone from 'tone';
import type { Instrument, InstrumentOptions } from 'tone/build/esm/instrument/Instrument';

type InstrumentConstructor = new (...args: any[]) => Instrument<InstrumentOptions>;

const carrierSounds: Record<string, string[]> = {
    dhl: ['A4', 'C5', 'A#4'],
    epost: ['F#5', 'F#5', 'D5', 'D5'],
    fedex: ['G5', 'Eb5'],
    ups: ['C5', 'E5', 'G5'],
    usps: ['C5', 'D5', 'A5', 'F5'],
};

export function carrierSound(carrierCode = '', Synth: InstrumentConstructor = Tone.Synth) {
    let pattern = Object.entries(carrierSounds).find(([code]) => carrierCode.startsWith(code))?.[1];
    if (!pattern) {
        pattern = randomCarrierNotes(3);
        carrierSounds[carrierCode] = pattern;
    }
    playNotes(pattern, Synth);
}

export function errorSound(Synth: InstrumentConstructor = Tone.DuoSynth) {
    console.log('errorSound', Synth.prototype.constructor.name);
    playNotes([0.1, 'F2', 0.05, '', 0.1, 'F2'], Synth);
}

function playNotes(notesOrDurations: Array<string | number>, Synth: InstrumentConstructor = Tone.Synth) {
    let delay = 0;
    let duration = 0.1;
    const synth = new Synth().toDestination();
    for (const val of notesOrDurations) {
        if (typeof val === 'number') {
            duration = val;
            continue;
        }
        // empty string will be a rest, non-empty will be a note
        if (val) {
            synth.triggerAttackRelease(val, duration, `+${delay}`);
        }
        delay += duration;
    }
}

function randomCarrierNotes(length: number): string[] {
    const notes = ['C5', 'D5', 'E5', 'F5', 'G5', 'A4', 'B4'];
    return Array.from({ length }, () => notes[Math.floor(Math.random() * notes.length)]);
}
