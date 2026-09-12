import { createContext, useContext } from "react";

export type TextToSpeech = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  available: boolean;
  isReady: boolean;
  isSpeaking: boolean;
  error: string | null;
  speak: (text: string) => Promise<void>;
  stopAudio: () => void;
};

export const TextToSpeechContext = createContext<TextToSpeech | null>(null);

export function useTextToSpeech(): TextToSpeech {
  const speech = useContext(TextToSpeechContext);
  if (!speech) throw new Error("Text-to-speech must be used inside TextToSpeechProvider");
  return speech;
}
