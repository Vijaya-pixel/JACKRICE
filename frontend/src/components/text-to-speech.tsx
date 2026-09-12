import { Square, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useElevenLabsTTS } from "@/hooks/useElevenLabsTTS";
import { TextToSpeechContext, useTextToSpeech } from "@/hooks/useTextToSpeech";

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

export function SpeechControls() {
  const { enabled, setEnabled, available, isReady, isSpeaking, error, stopAudio } =
    useTextToSpeech();
  const active = enabled && available;

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
        {!isReady
          ? "Loading voice..."
          : !available
            ? "Voice playback is unavailable on this device."
            : error
              ? "Speech could not play. Please try again."
              : active
                ? "Selected answers are read aloud."
                : "Voice playback is off."}
      </p>
    </div>
  );
}
