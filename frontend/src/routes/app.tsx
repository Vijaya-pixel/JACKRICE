import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  BookPlus,
  Camera,
  CameraOff,
  HeartPulse,
  Check,
  Keyboard,
  RotateCcw,
  Sun,
  SunDim,
  Undo2,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { useBlinkInput } from "@/hooks/useBlinkInput";
import { useEngineDiagnostics } from "@/hooks/useEngineDiagnostics";
import { useElevenLabsTTS } from "@/hooks/useElevenLabsTTS";
import { fetchNeedsSuggestions, recordSelection, useIsElectron } from "@/lib/tacit-api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [
      { title: "TACIT — Blink Communication Prototype" },
      {
        name: "description",
        content:
          "A calm contactless communication interface prototype for ICU and paralysis patients.",
      },
      { property: "og:title", content: "TACIT — Blink Communication Prototype" },
      {
        property: "og:description",
        content:
          "A calm contactless communication interface prototype for ICU and paralysis patients.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AppRoute,
});

function AppRoute() {
  return <TacitApp />;
}

type PatientScreen = "camera" | "calibration" | "yesno" | "needs" | "keyboard" | "confirmed";
type ScanItem = {
  label: string;
  value?: string;
  kind?: "letter" | "suggestion" | "sentence" | "undo" | "speak" | "dictionary";
};

const NEEDS: ScanItem[] = [
  { label: "Pain" },
  { label: "Thirsty" },
  { label: "Nurse" },
  { label: "Uncomfortable" },
  { label: "Family" },
  { label: "Yes" },
  { label: "No" },
  { label: "More time" },
];

const LETTERS = "ETAOINSHRDLUCMFPGWYBVKXJQZ".split("").map((label) => ({
  label,
  value: label,
  kind: "letter" as const,
}));

const SUGGESTIONS: ScanItem[] = [
  { label: "I need help", value: "I need help", kind: "suggestion" },
  { label: "Please call my family", value: "Please call my family", kind: "suggestion" },
  { label: "I am uncomfortable", value: "I am uncomfortable", kind: "suggestion" },
];

const NEXT_WORDS: Record<string, string[]> = {
  i: ["need", "want", "am", "feel", "would", "have"],
  you: ["are", "can", "need", "please", "want"],
  are: ["welcome", "leaving", "going", "right", "safe", "okay", "comfortable"],
  "i need": ["help", "water", "the", "to", "more", "my"],
  "i am": ["in", "very", "uncomfortable", "tired", "cold", "hot"],
  "please call": ["the", "my", "a", "nurse", "doctor", "family"],
  need: ["help", "water", "the", "a", "to", "more"],
  want: ["water", "food", "to", "my", "the", "more"],
  am: ["in", "very", "uncomfortable", "tired", "cold", "hot"],
  feel: ["sick", "better", "worse", "dizzy", "cold", "hot"],
  please: ["help", "call", "wait", "stop", "turn", "move"],
  call: ["the", "my", "a", "nurse", "doctor", "family"],
  my: ["family", "water", "medicine", "phone", "head", "back"],
  more: ["time", "water", "help", "please"],
};

const SENTENCE_PREDICTIONS = [
  "I need help", "I need water", "I need to use the bathroom", "I am in pain",
  "I am uncomfortable", "I feel sick", "I feel better", "Please call the nurse",
  "Please call my family", "Please reposition me", "Please give me more time",
  "Can you speak slowly", "I would like to rest", "I want to go home",
  "Thank you for helping me", "I need help right now", "I need my medicine",
  "I need to change position", "I have a headache", "I have trouble breathing",
  "My pain is getting worse", "My pain is getting better", "Please turn on the light",
  "Please close the curtain", "Please bring me a blanket", "Please tell the doctor",
  "Can you help me sit up", "Can you help me move", "I am ready to continue",
  "I am not ready yet",
];

const PREDICTION_HISTORY_KEY = "tacit:prediction-history";
const LOCAL_DICTIONARY_KEY = "tacit:local-dictionary";
const PREDICTION_SCOPE_KEY = "tacit:prediction-device-id";
type LocalPredictionDictionary = {
  words: Record<string, number>;
  bigrams: Record<string, number>;
  trigrams: Record<string, number>;
  phrases: Record<string, number>;
};

const COMMON_PREDICTIONS = [
  "a", "about", "after", "again", "all", "alone", "and", "another", "any", "anything",
  "are", "around", "as", "at", "awake", "back", "be", "because", "bed", "bedroom",
  "big", "blood", "breakfast", "bring", "button", "careful", "chair", "change",
  "comfortable", "continue", "day", "different", "do", "done", "down", "early",
  "enough", "evening", "every", "feel", "fever", "finished", "first", "follow",
  "from", "get", "give", "going", "goodbye", "head", "hear", "here", "ice",
  "important", "inside", "just", "keep", "know", "left", "listen", "little",
  "longer", "look", "make", "morning", "need", "next", "night", "nothing", "off",
  "on", "or", "our", "outside", "painful", "people", "please", "position", "quiet", "ready",
  "right", "room", "same", "see", "send", "share", "she", "should", "short", "show",
  "side", "something", "soon", "sound", "than", "thank", "that", "the", "their", "them",
  "then", "there", "these", "they", "think", "this", "those", "three", "time", "stay",
  "still", "strong", "support", "take", "tell", "today", "together", "too", "touch", "up",
  "use", "very", "voice", "walk", "warm", "watch", "we", "weak", "well", "what", "when",
  "where", "which", "who", "will", "with", "work", "would", "yes", "you", "your", "zero",
];

function predictionStorageKey(baseKey: string): string {
  if (typeof window === "undefined") return `${baseKey}:server`;
  try {
    let deviceId = localStorage.getItem(PREDICTION_SCOPE_KEY);
    if (!deviceId) {
      deviceId = typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(PREDICTION_SCOPE_KEY, deviceId);
    }
    return `${baseKey}:${deviceId}`;
  } catch {
    return `${baseKey}:temporary`;
  }
}

function loadPredictionHistory(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const stored = JSON.parse(localStorage.getItem(predictionStorageKey(PREDICTION_HISTORY_KEY)) || "{}");
    return stored && typeof stored === "object" ? stored : {};
  } catch { return {}; }
}

function loadLocalDictionary(): LocalPredictionDictionary {
  const empty = { words: {}, bigrams: {}, trigrams: {}, phrases: {} };
  if (typeof window === "undefined") return empty;
  try {
    const stored = JSON.parse(localStorage.getItem(predictionStorageKey(LOCAL_DICTIONARY_KEY)) || "{}");
    return {
      words: stored?.words && typeof stored.words === "object" ? stored.words : {},
      bigrams: stored?.bigrams && typeof stored.bigrams === "object" ? stored.bigrams : {},
      trigrams: stored?.trigrams && typeof stored.trigrams === "object" ? stored.trigrams : {},
      phrases: stored?.phrases && typeof stored.phrases === "object" ? stored.phrases : {},
    };
  } catch { return empty; }
}

function incrementCount(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] || 0) + 1;
}

function keepMostUseful(counts: Record<string, number>, limit: number) {
  return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a).slice(0, limit));
}

function learnLocalDictionary(message: string) {
  if (typeof window === "undefined") return;
  const phrase = message.trim().replace(/\s+/g, " ").toLowerCase();
  const words = phrase.match(/[a-z]+(?:'[a-z]+)?/g) || [];
  if (!words.length) return;
  const dictionary = loadLocalDictionary();
  incrementCount(dictionary.phrases, phrase);
  words.forEach((word) => incrementCount(dictionary.words, word));
  for (let index = 1; index < words.length; index += 1) incrementCount(dictionary.bigrams, `${words[index - 1]} ${words[index]}`);
  for (let index = 2; index < words.length; index += 1) incrementCount(dictionary.trigrams, `${words[index - 2]} ${words[index - 1]} ${words[index]}`);
  localStorage.setItem(predictionStorageKey(LOCAL_DICTIONARY_KEY), JSON.stringify({
    words: keepMostUseful(dictionary.words, 1000),
    bigrams: keepMostUseful(dictionary.bigrams, 2000),
    trigrams: keepMostUseful(dictionary.trigrams, 3000),
    phrases: keepMostUseful(dictionary.phrases, 300),
  }));
}

function addWordToLocalDictionary(word: string) {
  const normalized = word.trim().toLowerCase();
  if (!/^[a-z]+(?:'[a-z]+)?$/.test(normalized)) return;
  const dictionary = loadLocalDictionary();
  dictionary.words[normalized] = (dictionary.words[normalized] || 0) + 3;
  localStorage.setItem(predictionStorageKey(LOCAL_DICTIONARY_KEY), JSON.stringify({
    words: keepMostUseful(dictionary.words, 1000),
    bigrams: keepMostUseful(dictionary.bigrams, 2000),
    trigrams: keepMostUseful(dictionary.trigrams, 3000),
    phrases: keepMostUseful(dictionary.phrases, 300),
  }));
}

function rememberPredictionPhrase(message: string) {
  if (typeof window === "undefined") return;
  const phrase = message.trim().replace(/\s+/g, " ");
  if (!phrase) return;
  const history = loadPredictionHistory();
  history[phrase.toLowerCase()] = (history[phrase.toLowerCase()] || 0) + 1;
  localStorage.setItem(predictionStorageKey(PREDICTION_HISTORY_KEY), JSON.stringify(
    Object.fromEntries(Object.entries(history).sort(([, a], [, b]) => b - a).slice(0, 100)),
  ));
  learnLocalDictionary(message);
}

function getKeyboardPredictions(message: string): ScanItem[] {
  if (!message.trim()) return SUGGESTIONS;
  const normalizedMessage = message.toLowerCase().trim();
  const history = loadPredictionHistory();
  const dictionary = loadLocalDictionary();
  const sentenceMatches = [...new Set([
    ...Object.keys(history), ...Object.keys(dictionary.phrases),
    ...SENTENCE_PREDICTIONS.map((sentence) => sentence.toLowerCase()),
  ])].filter((sentence) => sentence.startsWith(normalizedMessage)).sort(
    (first, second) => (history[second] || 0) - (history[first] || 0),
  ).slice(0, 2);
  const words = normalizedMessage.split(/\s+/);
  const hasTrailingSpace = message.endsWith(" ");
  const currentWord = words.at(-1) ?? "";
  const prefix = hasTrailingSpace ? "" : currentWord;
  const previous = hasTrailingSpace ? currentWord : words.at(-2) ?? "";
  const contextKey = words.slice(-2).join(" ");
  const contextual = !hasTrailingSpace && NEXT_WORDS[currentWord] ? NEXT_WORDS[currentWord] : NEXT_WORDS[previous] ?? [];
  const learnedContext = hasTrailingSpace ? Object.entries(dictionary.bigrams)
    .filter(([pair]) => pair.startsWith(`${currentWord} `)).sort(([, a], [, b]) => b - a)
    .map(([pair]) => pair.split(" ").at(-1) || "") : [];
  const learnedTrigramContext = hasTrailingSpace ? Object.entries(dictionary.trigrams)
    .filter(([trigram]) => trigram.startsWith(`${contextKey} `)).sort(([, a], [, b]) => b - a)
    .map(([trigram]) => trigram.split(" ").at(-1) || "") : [];
  const learnedWords = Object.entries(dictionary.words).sort(([, a], [, b]) => b - a).map(([word]) => word);
  const candidates = [...(NEXT_WORDS[contextKey] ?? []), ...learnedTrigramContext, ...learnedContext, ...contextual, ...learnedWords, ...COMMON_PREDICTIONS];
  const wordMatches = [...new Set(candidates)].filter((word) => word.startsWith(prefix)).slice(0, 3)
    .map((word) => ({ label: word, value: word, kind: "suggestion" as const }));
  return [...sentenceMatches.map((sentence) => ({ label: sentence, value: sentence, kind: "sentence" as const })), ...wordMatches].slice(0, 3);
}

const NEED_TONES = [
  "bg-pastel-green/70",
  "bg-pastel-mint/70",
  "bg-pastel-blush/70",
  "bg-pastel-blue/70",
];

function useScanner(length: number, active = true, speed = 1500) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active || length === 0) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % length), speed);
    return () => window.clearInterval(timer);
  }, [active, length, speed]);
  useEffect(() => setIndex(0), [length]);
  return { index, setIndex };
}

function TacitApp() {
  const [screen, setScreen] = useState<PatientScreen>("camera");
  const [message, setMessage] = useState("");
  const [spokenMessage, setSpokenMessage] = useState("");
  const electron = useIsElectron();
  const tts = useElevenLabsTTS();

  return (
    <main className="min-h-svh bg-background text-foreground">
      <SiteHeader />

      <PatientView
        screen={screen}
        setScreen={setScreen}
        message={message}
        setMessage={setMessage}
        spokenMessage={spokenMessage}
        setSpokenMessage={setSpokenMessage}
        speak={tts.speak}
      />

      <footer className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-background/95 px-4 py-2 text-center text-xs text-muted-foreground backdrop-blur-md">
        {electron
          ? "Live blink detection via the desktop app's camera — press spacebar as a manual override"
          : "Browser preview — blink detection simulated via spacebar for demo purposes"}
      </footer>
    </main>
  );
}

function PatientView({
  screen,
  setScreen,
  message,
  setMessage,
  spokenMessage,
  setSpokenMessage,
  speak,
}: {
  screen: PatientScreen;
  setScreen: (screen: PatientScreen) => void;
  message: string;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  spokenMessage: string;
  setSpokenMessage: (message: string) => void;
  speak: (text: string) => Promise<void>;
}) {
  const [dictionaryWord, setDictionaryWord] = useState<string | null>(null);

  return (
    <div className="flex min-h-svh flex-col px-5 pb-16 pt-24 md:px-10">
      {screen !== "camera" && screen !== "calibration" && screen !== "confirmed" && (
        <nav
          className="mx-auto mb-6 flex w-full max-w-6xl items-center justify-between"
          aria-label="Communication modes"
        >
          <p className="text-sm font-medium text-muted-foreground">
            Blink to select the highlighted choice
          </p>
          <div className="flex gap-2">
            <Button
              variant={screen === "needs" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setScreen("needs")}
            >
              <HeartPulse /> Needs
            </Button>
            <Button
              variant={screen === "keyboard" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setScreen("keyboard")}
            >
              <Keyboard /> Spell
            </Button>
          </div>
        </nav>
      )}
      <div className="flex flex-1 items-center justify-center">
        {screen === "camera" && <CameraCheck onDone={() => setScreen("calibration")} />}
        {screen === "calibration" && <Calibration onDone={() => setScreen("yesno")} />}
        {screen === "yesno" && <YesNo onDone={() => setScreen("needs")} speak={speak} />}
        {screen === "needs" && (
          <NeedsBoard
            onSelect={(value) => {
              setSpokenMessage(value === "More time" ? "I need more time" : value);
              setScreen("confirmed");
            }}
            speak={speak}
          />
        )}
        {screen === "keyboard" && (
          <ScanningKeyboard
            message={message}
            setMessage={setMessage}
            onSpeak={(value) => {
              const spoken = value || "I need help";
              const word = spoken.trim().toLowerCase();
              setSpokenMessage(spoken);
              setDictionaryWord(/^[a-z]+(?:'[a-z]+)?$/.test(word) ? word : null);
              setScreen("confirmed");
            }}
            speak={speak}
          />
        )}
        {screen === "confirmed" && (
          <Confirmed
            message={spokenMessage}
            dictionaryWord={dictionaryWord}
            onAddWord={() => {
              if (dictionaryWord) addWordToLocalDictionary(dictionaryWord);
              setDictionaryWord(null);
            }}
            onAgain={() => {
              setMessage("");
              setDictionaryWord(null);
              setScreen("needs");
            }}
          />
        )}
      </div>
    </div>
  );
}

function CameraCheck({ onDone }: { onDone: () => void }) {
  const [cameraOn, setCameraOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenLightOn, setScreenLightOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    };
  }, []);

  // The screen-light overlay is only useful while the camera is actually on.
  useEffect(() => {
    if (!cameraOn) setScreenLightOn(false);
  }, [cameraOn]);

  async function openCamera() {
    if (streamRef.current) return; // already open or opening — ignore a repeat click
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
      streamRef.current = stream;
      setError(null);
      setCameraOn(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch (playErr) {
          // A fast unmount/remount (HMR, rapid clicks) can abort play() even
          // though the camera stream itself was granted fine — not a real failure.
          if (!(playErr instanceof DOMException && playErr.name === "AbortError")) throw playErr;
        }
      }
    } catch (err) {
      const name = err instanceof DOMException ? err.name : typeof err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tacit] getUserMedia failed: ${name} — ${message}`);
      streamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      streamRef.current = null;
      setCameraOn(false);
      setError("Camera unavailable — you can continue without it for this demo.");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }

  return (
    <>
      {screenLightOn && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-white">
          <Button
            size="lg"
            variant="outline"
            onClick={() => setScreenLightOn(false)}
            className="border-black/15 bg-white text-black hover:bg-black/5"
          >
            <SunDim /> Turn off screen light
          </Button>
        </div>
      )}
      <section className="w-full max-w-3xl animate-fade-in text-center" aria-label="Camera check">
      <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        Step 1 · Diagnosis check
      </p>
      <h1 className="font-display text-3xl font-semibold md:text-5xl">Let’s check the camera</h1>
      <p className="mx-auto mt-4 max-w-lg text-lg text-muted-foreground">
        Position the camera so the patient’s face is clearly visible, then continue.
      </p>

      <div className="relative mx-auto mt-8 aspect-video w-full overflow-hidden rounded-lg border-2 border-border bg-[#0d1424]">
        <video
          ref={videoRef}
          muted
          playsInline
          className={cn("absolute inset-0 h-full w-full object-cover", !cameraOn && "opacity-0")}
          aria-hidden="true"
        />
        {!cameraOn && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="text-center">
              <Camera className="mx-auto mb-3 size-10 text-white/40" />
              <p className="text-sm text-white/50">Camera is off</p>
            </div>
          </div>
        )}
        {cameraOn && (
          <div className="absolute bottom-3 left-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
            <span className="rounded-md bg-signal px-2 py-1 text-signal-foreground">
              Face detected
            </span>
            <span className="rounded-md bg-black/40 px-2 py-1 text-white/80">Tracking: good</span>
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-amber">{error}</p>}

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button size="lg" variant="outline" onClick={cameraOn ? stopCamera : openCamera}>
          {cameraOn ? <CameraOff /> : <Camera />}
          {cameraOn ? "Close camera" : "Open camera"}
        </Button>
        {cameraOn && (
          <Button size="lg" variant="outline" onClick={() => setScreenLightOn(true)}>
            <Sun /> Brighten screen for lighting
          </Button>
        )}
        <Button
          size="lg"
          onClick={() => {
            stopCamera();
            onDone();
          }}
        >
          {cameraOn ? "Looks good — begin calibration" : "Skip and begin calibration"}
        </Button>
      </div>
      </section>
    </>
  );
}

function Calibration({ onDone }: { onDone: () => void }) {
  const diagnostics = useEngineDiagnostics();
  const startedRef = useRef(false);
  const gazeStartedRef = useRef(false);

  // Electron: (re)run calibration fresh each time this screen is reached,
  // rather than relying on the engine's one-shot auto-calibration from when
  // the hidden engine-host window first started (which likely finished
  // before the user got here). Eye tracking is off by default in the engine
  // host (see engineHostRenderer.js) — turn it on here so gaze centering
  // below has real sub-pixel gaze to sample.
  useEffect(() => {
    if (diagnostics.available && !startedRef.current) {
      startedRef.current = true;
      diagnostics.setEyeTracking(true);
      diagnostics.calibrate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagnostics.available]);

  // Once blink calibration settles, center gaze ("look at the middle of the
  // screen") before moving on. Skipped if blink calibration itself failed —
  // there is no reliable eye signal to center against yet.
  useEffect(() => {
    if (!diagnostics.available || gazeStartedRef.current) return;
    if (diagnostics.calibration === "done") {
      gazeStartedRef.current = true;
      diagnostics.calibrateGaze();
    } else if (diagnostics.calibration === "failed") {
      gazeStartedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagnostics.available, diagnostics.calibration]);

  useEffect(() => {
    if (diagnostics.available) {
      const blinkSettled =
        diagnostics.calibration === "done" || diagnostics.calibration === "failed";
      const gazeSettled =
        diagnostics.calibration === "failed" ||
        diagnostics.gazeCalibration === "done" ||
        diagnostics.gazeCalibration === "failed";
      if (blinkSettled && gazeSettled) {
        const timer = window.setTimeout(onDone, 600);
        return () => window.clearTimeout(timer);
      }
      return;
    }
    // Browser mode, or the engine hasn't reported in yet: keep the original
    // simulated delay so the demo still flows without Electron.
    const timer = window.setTimeout(onDone, 3400);
    return () => window.clearTimeout(timer);
  }, [diagnostics.available, diagnostics.calibration, diagnostics.gazeCalibration, onDone]);

  const centeringGaze =
    diagnostics.calibration === "done" &&
    (diagnostics.gazeCalibration === "sampling" || diagnostics.gazeCalibration === "idle");

  const vitalsLabel =
    diagnostics.vitalsCalibration === "ready"
      ? null
      : diagnostics.vitalsCalibration === "timeout"
        ? "Still reading your pulse — hold still if you can"
        : diagnostics.vitalsCalibration === "sampling"
          ? "Reading your pulse..."
          : null;

  return (
    <section
      className="animate-fade-in text-center"
      aria-label={centeringGaze ? "Centering gaze tracking" : "Calibrating blink detection"}
    >
      <div className="calibration-ring mx-auto mb-10 grid size-56 place-items-center rounded-full md:size-64">
        <div className="grid size-[82%] place-items-center rounded-full bg-background">
          <div>
            <Activity className="mx-auto mb-2 size-8 text-primary" />
            <span className="font-display text-3xl font-semibold">
              {centeringGaze ? "Look here" : "Calibrating"}
            </span>
          </div>
        </div>
      </div>
      <h1 className="font-display text-3xl font-semibold md:text-5xl">
        {centeringGaze
          ? "Now look at the middle of the screen..."
          : "Getting to know your blink..."}
      </h1>
      <p className="mx-auto mt-5 max-w-lg text-lg text-muted-foreground">
        {centeringGaze
          ? "Keep looking here for a couple seconds."
          : "Keep your eyes relaxed. There is nothing you need to do."}
      </p>
      <div className="mx-auto mt-8 flex w-fit items-center gap-2 text-sm text-primary">
        <span className="size-2 rounded-full bg-primary motion-safe:animate-pulse" />
        Preparing your controls
      </div>
      {vitalsLabel && (
        <p className="mx-auto mt-3 max-w-lg text-sm text-muted-foreground">{vitalsLabel}</p>
      )}
    </section>
  );
}

function YesNo({ onDone, speak }: { onDone: () => void; speak: (text: string) => Promise<void> }) {
  const { index, setIndex } = useScanner(2);
  const [selected, setSelected] = useState<number | null>(null);
  const choose = useCallback(
    (choice: number) => {
      if (selected !== null) return;
      setSelected(choice);
      const text = choice === 0 ? "Yes" : "No";
      void recordSelection({
        text,
        source: "suggested",
        how: "blink",
      });
      // Speak immediately
      void speak(text);
      window.setTimeout(onDone, 900);
    },
    [onDone, selected, speak],
  );
  useBlinkInput(() => choose(index));

  return (
    <section className="w-full max-w-5xl animate-fade-in text-center">
      <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        Let’s start simply
      </p>
      <h1 className="font-display text-3xl font-semibold md:text-5xl">
        Can you see both choices clearly?
      </h1>
      <div className="mt-10 grid gap-5 sm:grid-cols-2">
        {["Yes", "No"].map((label, itemIndex) => (
          <ScanButton
            key={label}
            active={index === itemIndex}
            selected={selected === itemIndex}
            onClick={() => {
              setIndex(itemIndex);
              choose(itemIndex);
            }}
          >
            <span className="font-display text-5xl font-semibold md:text-7xl">{label}</span>
          </ScanButton>
        ))}
      </div>
    </section>
  );
}

function NeedsBoard({ onSelect, speak }: { onSelect: (value: string) => void; speak: (text: string) => Promise<void> }) {
  // Electron: the first five slots come from Gemini (falls back to the
  // static needs below on error or in the browser); Yes/No/More time stay
  // fixed — same 8-slot grid shape and styling as before either way.
  const [items, setItems] = useState<ScanItem[]>(NEEDS);
  const [suggestionSource, setSuggestionSource] = useState<"gemini" | "fallback">("fallback");

  useEffect(() => {
    let cancelled = false;
    fetchNeedsSuggestions({}).then((response) => {
      if (cancelled) return;
      setSuggestionSource(response.source);
      const suggested = response.options.slice(0, 5).map((label) => ({ label }));
      setItems([...suggested, { label: "Yes" }, { label: "No" }, { label: "More time" }]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const { index, setIndex } = useScanner(items.length);
  const [selected, setSelected] = useState<number | null>(null);
  const choose = useCallback(
    (choice: number) => {
      if (selected !== null) return;
      setSelected(choice);
      const label = items[choice]?.label ?? "";
      void recordSelection({ text: label, source: "suggested", how: "blink" });
      // Speak immediately
      void speak(label);
      window.setTimeout(() => onSelect(label), 850);
    },
    [items, onSelect, selected, speak],
  );
  useBlinkInput(() => choose(index));

  return (
    <section className="w-full max-w-6xl animate-fade-in">
      <div className="mb-7 text-center">
        <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
          Quick needs{suggestionSource === "gemini" ? " · Gemini-assisted" : ""}
        </p>
        <h1 className="font-display text-3xl font-semibold md:text-5xl">
          What would you like to say?
        </h1>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        {items.map((item, itemIndex) => (
          <ScanButton
            key={`${item.label}-${itemIndex}`}
            active={index === itemIndex}
            selected={selected === itemIndex}
            compact
            tone={NEED_TONES[itemIndex % NEED_TONES.length] ?? "bg-card"}
            onClick={() => {
              setIndex(itemIndex);
              choose(itemIndex);
            }}
          >
            <span className="font-display text-xl font-semibold md:text-3xl">{item.label}</span>
          </ScanButton>
        ))}
      </div>
    </section>
  );
}

function ScanButton({
  active,
  selected,
  compact,
  tone,
  children,
  onClick,
}: {
  active: boolean;
  selected: boolean;
  compact?: boolean;
  tone?: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "scan-target relative flex w-full items-center justify-center overflow-hidden rounded-lg border-2 bg-card px-4 transition-all duration-300 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring",
        tone,
        compact ? "min-h-28 md:min-h-40" : "min-h-48 md:min-h-64",
        active && "scan-active border-scan bg-scan/10 text-foreground",
        selected && "scan-selected border-success bg-success text-success-foreground",
      )}
      aria-current={active ? "true" : undefined}
    >
      {selected && <Check className="absolute right-5 top-5 size-7" />}
      {children}
    </button>
  );
}

function ScanningKeyboard({
  message,
  setMessage,
  onSpeak,
  speak,
}: {
  message: string;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  onSpeak: (value: string) => void;
  speak: (text: string) => Promise<void>;
}) {
  const predictions = getKeyboardPredictions(message);
  const scanItems = useMemo<ScanItem[]>(
    () => [
      ...predictions,
      ...LETTERS,
      { label: "Space", value: " ", kind: "letter" },
      { label: "Undo", kind: "undo" },
      { label: "Speak", kind: "speak" },
      { label: "Add word", kind: "dictionary" },
    ],
    [predictions],
  );
  const { index, setIndex } = useScanner(scanItems.length, true, 700);
  const [selected, setSelected] = useState<number | null>(null);

  const choose = useCallback(
    (choice: number) => {
      const item = scanItems[choice];
      if (!item || selected !== null) return;
      setSelected(choice);
      if (item.kind === "undo") setMessage((current) => current.slice(0, -1));
      else if (item.kind === "speak") {
        void recordSelection({ text: message, source: "typed", how: "blink" });
        rememberPredictionPhrase(message);
        // Speak immediately
        void speak(message);
        onSpeak(message);
      } else if (item.kind === "dictionary") {
        const word = message.trim().split(/\s+/).at(-1) ?? "";
        addWordToLocalDictionary(word);
      } else if (item.kind === "sentence") {
        setMessage(item.value ?? item.label);
      } else if (item.kind === "suggestion") {
        setMessage((current) => {
          if (!current.trim()) return item.value ?? item.label;
          if (current.endsWith(" ")) return `${current}${item.value ?? item.label} `;
          const words = current.split(/\s+/);
          words[words.length - 1] = item.value ?? item.label;
          return `${words.join(" ")} `;
        });
      } else if (item.kind === "letter") {
        const value = item.value ?? item.label;
        setMessage((current) => {
          if (value === " ") return `${current} `;
          const startsSentence = current.trim() === "" || /[.!?]\s*$/.test(current);
          return current + (startsSentence ? value.toLowerCase().toUpperCase() : value.toLowerCase());
        });
      } else {
        setMessage((current) => current + (item.value ?? item.label));
      }
      window.setTimeout(() => setSelected(null), 320);
    },
    [message, onSpeak, scanItems, selected, setMessage, speak],
  );
  useBlinkInput(() => choose(index));

  return (
    <section className="w-full max-w-6xl animate-fade-in py-2">
      <p className="mb-2 text-center text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        Compose a message
      </p>
      <div className="mb-4 min-h-24 rounded-lg border border-border bg-card p-5 shadow-sm md:min-h-28 md:p-7">
        <p
          className={cn(
            "font-display text-2xl font-medium md:text-4xl",
            !message && "text-muted-foreground",
          )}
        >
          {message || "Your message will appear here"}
          <span className="ml-1 inline-block h-8 w-0.5 bg-primary align-middle motion-safe:animate-pulse" />
        </p>
      </div>
      <div className="mb-4 grid gap-2 md:grid-cols-3">
        {predictions.map((item, suggestionIndex) => (
          <KeyboardKey
            key={item.label}
            label={item.label}
            active={index === suggestionIndex}
            selected={selected === suggestionIndex}
            wide
            onClick={() => {
              setIndex(suggestionIndex);
              choose(suggestionIndex);
            }}
          />
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-10 md:grid-cols-10 md:gap-2">
        {LETTERS.map((item, letterIndex) => {
          const itemIndex = letterIndex + predictions.length;
          return (
            <KeyboardKey
              key={item.label}
              label={item.label}
              active={index === itemIndex}
              selected={selected === itemIndex}
              onClick={() => {
                setIndex(itemIndex);
                choose(itemIndex);
              }}
            />
          );
        })}
        {scanItems.slice(-4).map((item, offset) => {
          const itemIndex = scanItems.length - 4 + offset;
          return (
            <KeyboardKey
              key={item.label}
              label={item.label}
              icon={
                item.kind === "undo"
                  ? <Undo2 />
                  : item.kind === "speak"
                    ? <Volume2 />
                    : item.kind === "dictionary"
                      ? <BookPlus />
                      : undefined
              }
              active={index === itemIndex}
              selected={selected === itemIndex}
              wide
              onClick={() => {
                setIndex(itemIndex);
                choose(itemIndex);
              }}
            />
          );
        })}
      </div>
    </section>
  );
}

function KeyboardKey({
  label,
  active,
  selected,
  wide,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  selected: boolean;
  wide?: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-14 items-center justify-center gap-2 rounded-md border border-border bg-card px-2 font-display text-lg font-semibold transition-all duration-200 md:min-h-16 md:text-xl",
        wide && "col-span-2 md:col-auto",
        active && "scan-active border-scan bg-scan/15 ring-2 ring-scan",
        selected && "bg-success text-success-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Confirmed({
  message,
  dictionaryWord,
  onAddWord,
  onAgain,
}: {
  message: string;
  dictionaryWord: string | null;
  onAddWord: () => void;
  onAgain: () => void;
}) {
  return (
    <section className="w-full max-w-4xl animate-fade-in text-center">
      <div className="mx-auto mb-8 grid size-16 place-items-center rounded-full bg-success text-success-foreground">
        <Check className="size-8" />
      </div>
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-success">
        Message confirmed
      </p>
      <h1 className="mx-auto mt-5 max-w-3xl font-display text-4xl font-semibold leading-tight md:text-7xl">
        “{message}”
      </h1>
      <div className="mx-auto mt-10 flex w-fit items-center gap-5 rounded-lg border border-border bg-card px-8 py-5">
        <Volume2 className="size-7 text-primary" />
        <div className="sound-wave flex h-9 items-center gap-1" aria-label="Speaking">
          {[0, 1, 2, 3, 4].map((bar) => (
            <span key={bar} style={{ animationDelay: `${bar * 0.12}s` }} />
          ))}
        </div>
        <span className="font-medium">Speaking</span>
      </div>
      {dictionaryWord && (
        <Button variant="outline" className="mt-6" onClick={onAddWord}>
          Add “{dictionaryWord}” to dictionary
        </Button>
      )}
      <Button size="lg" variant="secondary" className="mt-10" onClick={onAgain}>
        <RotateCcw /> New message
      </Button>
    </section>
  );
}
