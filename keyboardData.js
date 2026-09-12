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
  'all', 'alone', 'another', 'anything', 'around', 'awake', 'back', 'bed', 'bedroom',
  'big', 'blood', 'breakfast', 'bring', 'button', 'careful', 'chair', 'change',
  'comfortable', 'continue', 'day', 'different', 'do', 'done', 'down', 'early',
  'enough', 'evening', 'every', 'feel', 'fever', 'finished', 'first', 'follow',
  'from', 'gel', 'get', 'give', 'going', 'goodbye', 'head', 'hear', 'here', 'home',
  'ice', 'important', 'inside', 'just', 'keep', 'know', 'left', 'listen', 'little',
  'longer', 'look', 'make', 'morning', 'need', 'next', 'night', 'nothing', 'off',
  'on', 'outside', 'painful', 'position', 'quiet', 'ready', 'right', 'room', 'same',
  'see', 'send', 'share', 'short', 'show', 'side', 'something', 'soon', 'sound',
  'stay', 'still', 'strong', 'support', 'take', 'tell', 'there', 'today', 'together',
  'too', 'touch', 'up', 'use', 'voice', 'walk', 'warm', 'watch', 'weak', 'well',
  'with', 'work', 'yes', 'your', 'zero',
];

export const COMMON_SENTENCES = [
  'I need help', 'I need water', 'I need to use the bathroom', 'I am in pain',
  'I am uncomfortable', 'I feel sick', 'I feel better', 'Please call the nurse',
  'Please call my family', 'Please reposition me', 'Please give me more time',
  'Can you speak slowly', 'I would like to rest', 'I want to go home',
  'Thank you for helping me', 'I need help right now', 'I need my medicine',
  'I need to change position', 'I have a headache', 'I have trouble breathing',
  'My pain is getting worse', 'My pain is getting better', 'Please turn on the light',
  'Please close the curtain', 'Please bring me a blanket', 'Please tell the doctor',
  'Can you help me sit up', 'Can you help me move', 'I am ready to continue',
  'I am not ready yet',
];

const NEXT_WORDS = {
  i: ['need', 'want', 'am', 'feel', 'would', 'have'],
  you: ['are', 'can', 'need', 'please', 'want'],
  are: ['welcome', 'leaving', 'going', 'right', 'safe', 'okay', 'comfortable'],
  need: ['help', 'water', 'the', 'a', 'to', 'more'],
  want: ['water', 'food', 'to', 'my', 'the', 'more'],
  am: ['in', 'very', 'uncomfortable', 'tired', 'cold', 'hot'],
  feel: ['sick', 'better', 'worse', 'dizzy', 'cold', 'hot'],
  please: ['help', 'call', 'wait', 'stop', 'turn', 'move'],
  call: ['the', 'my', 'a', 'nurse', 'doctor', 'family'],
  my: ['family', 'water', 'medicine', 'phone', 'head', 'back'],
  more: ['time', 'water', 'help', 'please'],
};

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

export function predictSentences(text, limit = 3) {
  const needle = String(text || '').trim().toLowerCase();
  return COMMON_SENTENCES.filter(sentence => !needle || sentence.toLowerCase().startsWith(needle)).slice(0, limit);
}

export function predictNextWords(text, limit = 5) {
  const normalized = String(text || '').trim().toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  const prefix = words.pop() || '';
  const previous = words[words.length - 1] || '';
  const candidates = NEXT_WORDS[previous] || COMMON_WORDS;
  return [...new Set(candidates.filter(word => word.startsWith(prefix)))].slice(0, limit);
}
