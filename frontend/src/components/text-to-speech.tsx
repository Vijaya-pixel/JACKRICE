import { Square, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useElevenLabsTTS } from "@/hooks/useElevenLabsTTS";
import { TextToSpeechContext, useTextToSpeech } from "@/hooks/useTextToSpeech";
import { cn } from "@/lib/utils";

const TTS_ENABLED_KEY = "tacit:ttsEnabled";

export function TextToSpeechProvider({ children }: { children: ReactNode }) {
  const voice = useElevenLabsTTS();
  const [enabled, setEnabledState] = useState(false);
  const enabledRef = useRef(false);

  useEffect(() => {
    let saved = true;
    try {
      saved = window.localStorage.getItem(TTS_ENABLED_KEY) !== "false";
    } catch {
      // Voice controls still work when browser storage is unavailable.
    }
    enabledRef.current = saved;
    setEnabledState(saved);
  }, []);

  const { speak: speakWithVoice, stopAudio } = voice;
  const setEnabled = useCallback(
    (next: boolean) => {
      enabledRef.current = next;
      setEnabledState(next);
      if (!next) stopAudio();
      try {
        window.localStorage.setItem(TTS_ENABLED_KEY, String(next));
      } catch {
        // Keep the current setting for this visit if it cannot be saved.
      }
    },
    [stopAudio],
  );

  const speak = useCallback(
    async (text: string) => {
      if (enabledRef.current) await speakWithVoice(text);
    },
    [speakWithVoice],
  );

  return (
    <TextToSpeechContext.Provider value={{ ...voice, enabled, setEnabled, speak }}>
      {children}
    </TextToSpeechContext.Provider>
  );
}

/**
 * Icon-only voice toggle for the side rail. One click flips text-to-speech
 * on/off; the full status ("unavailable on this device", etc.) lives in the
 * tooltip/aria-label instead of taking up space. Shows a stop button
 * underneath only while something is being read aloud.
 */
export function SpeechToggleButton({ className }: { className?: string }) {
  const { enabled, setEnabled, available, isReady, isSpeaking, error, stopAudio } =
    useTextToSpeech();
  const active = enabled && available;
  const statusText = !isReady
    ? "Loading voice..."
    : !available
      ? "Voice playback is unavailable on this device."
      : error
        ? "Speech could not play. Please try again."
        : active
          ? "Voice on — selected answers are read aloud. Click to turn off."
          : "Voice off. Click to turn on.";

  return (
    <div
      className={cn("flex flex-col items-center gap-2", className)}
      onKeyDown={(event) => {
        // Space should operate the focused voice control, not select a patient answer.
        if (event.code === "Space") event.stopPropagation();
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-label={`Text-to-speech: ${statusText}`}
        title={statusText}
        disabled={!isReady || !available}
        onClick={() => setEnabled(!active)}
        className={cn(
          "grid size-11 place-items-center rounded-lg border shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          active
            ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
            : "border-border bg-card text-muted-foreground hover:bg-background",
        )}
      >
        {active ? (
          <Volume2 className="size-5" aria-hidden="true" />
        ) : (
          <VolumeX className="size-5" aria-hidden="true" />
        )}
      </button>
      {isSpeaking && (
        <button
          type="button"
          onClick={stopAudio}
          aria-label="Stop speaking"
          title="Stop speaking"
          className="grid size-11 place-items-center rounded-lg border border-border bg-card text-foreground shadow-sm transition-colors hover:bg-background"
        >
          <Square className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** Voice on/off toggle as a right-aligned bar above the content (used on the
 *  pre-calibration screens, which have no side rail). */
export function SpeechControls() {
  const { enabled, setEnabled, available, isReady, isSpeaking, error, stopAudio } =
    useTextToSpeech();
  const active = enabled && available;

  const statusText = !isReady
    ? "Loading voice..."
    : !available
      ? "Voice playback is unavailable on this device."
      : error
        ? "Speech could not play. Please try again."
        : active
          ? "Selected answers are read aloud."
          : "Voice playback is off.";

  return (
    <div
      className="mb-6 flex flex-wrap items-center justify-end gap-3"
      aria-label="Voice controls"
      onKeyDown={(event) => {
        // Space should operate the focused voice control, not select a patient answer.
        if (event.code === "Space") event.stopPropagation();
      }}
    >
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
        {active ? (
          <Volume2 className="size-5 text-primary" aria-hidden="true" />
        ) : (
          <VolumeX className="size-5 text-muted-foreground" aria-hidden="true" />
        )}
        <label htmlFor="tts-enabled" className="cursor-pointer text-sm font-semibold">
          Text-to-speech {active ? "on" : "off"}
        </label>
        <Switch
          id="tts-enabled"
          aria-label="Text-to-speech"
          checked={active}
          onCheckedChange={setEnabled}
          disabled={!isReady || !available}
        />
      </div>
      {isSpeaking && (
        <Button type="button" variant="outline" onClick={stopAudio}>
          <Square className="size-4" aria-hidden="true" />
          Stop speaking
        </Button>
      )}
      <p role="status" className="w-full text-right text-xs text-muted-foreground">
        {statusText}
      </p>
    </div>
  );
}
