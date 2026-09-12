// keyboardData.js — static data for the tier-3 scanning keyboard.
// Pure data/helpers, no DOM or Electron access, so it bundles into the
// renderer with esbuild exactly like the rest of yesnoApp.js's imports.

// English letter frequency, most common first. Laying the keyboard out this
// way (rather than alphabetically or QWERTY) means the letters most words
// need sit in the earliest rows, cutting the average blinks-per-letter for
// row/column scanning — the same idea behind dedicated AAC frequency layouts.
export const FREQUENCY_LETTERS = [
  'e', 't', 'a', 'o', 'i', 'n', 's', 'h', 'r', 'd', 'l', 'c', 'u',
  'm', 'w', 'f', 'g', 'y', 'p', 'b', 'v', 'k', 'j', 'x', 'q', 'z',
];

// A small hospital/AAC-flavored word list, roughly frequency-ordered, used
// for prefix-based word completion while spelling on the scanning keyboard.
export const COMMON_WORDS = [
  'i', 'you', 'the', 'is', 'it', 'me', 'my', 'to', 'a', 'and', 'not', 'no', 'yes',
  'pain', 'hurt', 'hurts', 'water', 'thirsty', 'hungry', 'food', 'eat', 'drink',
  'help', 'nurse', 'doctor', 'please', 'need', 'want', 'more', 'stop', 'wait',
  'cold', 'hot', 'tired', 'sleep', 'sit', 'stand', 'move', 'turn', 'breathe',
  'bathroom', 'toilet', 'itchy', 'uncomfortable', 'ok', 'okay', 'thanks', 'thank',
  'sorry', 'later', 'now', 'family', 'phone', 'call', 'tv', 'light', 'dark',
  'blanket', 'pillow', 'medicine', 'nauseous', 'dizzy', 'better', 'worse', 'good',
  'bad', 'scared', 'worried', 'love', 'home', 'when', 'where', 'what', 'why', 'how',
];

// Split into fixed-size rows for the keyboard grid (last row may be short).
export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Word completions for the given prefix, in COMMON_WORDS' own frequency
// order. Empty prefix returns the overall most-common words as starters.
export function predictWords(prefix, limit = 5) {
  const needle = String(prefix || '').trim().toLowerCase();
  const matches = needle ? COMMON_WORDS.filter(word => word.startsWith(needle)) : COMMON_WORDS;
  return matches.slice(0, limit);
}
