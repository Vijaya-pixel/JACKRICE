import { useCallback, useEffect, useRef, useState } from "react";

import { createElevenLabsService, getElevenLabsApiKey } from "@/lib/elevenlabs-service";

/** Fetch credentials once and track the full request and playback lifecycle. */
export function useElevenLabsTTS() {
  const [player] = useState(createElevenLabsService);
  const [isReady, setIsReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apiKeyRef = useRef("");
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    void getElevenLabsApiKey().then((key) => {
      if (!active) return;
      apiKeyRef.current = key;
      setAvailable(Boolean(key));
      setIsReady(true);
    });
    return () => {
      active = false;
      mountedRef.current = false;
      requestRef.current += 1;
      apiKeyRef.current = "";
      player.stopAudio();
    };
  }, [player]);

  const stopAudio = useCallback(() => {
    requestRef.current += 1;
    player.stopAudio();
    if (mountedRef.current) {
      setIsSpeaking(false);
      setError(null);
    }
  }, [player]);

  const speak = useCallback(
    async (text: string): Promise<void> => {
      if (!mountedRef.current || !apiKeyRef.current || !text.trim()) return;
      const request = ++requestRef.current;
      setError(null);
      setIsSpeaking(true);
      try {
        await player.speak(text, apiKeyRef.current);
      } catch (cause) {
        if (
          mountedRef.current &&
          request === requestRef.current &&
          !(cause instanceof Error && cause.name === "AbortError")
        ) {
          setError(cause instanceof Error ? cause.message : "Speech playback failed. Try again.");
        }
      } finally {
        if (mountedRef.current && request === requestRef.current) setIsSpeaking(false);
      }
    },
    [player],
  );

  return { speak, stopAudio, isReady, available, isSpeaking, error };
}
