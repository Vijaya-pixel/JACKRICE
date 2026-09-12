/**
 * useElevenLabsTTS — React hook for text-to-speech using Eleven Labs.
 * Fetches the API key from the Electron bridge on mount.
 */

import { useEffect, useRef, useState } from "react";

import { getElevenLabsApiKey, speak as elevenLabsSpeak, stopAudio } from "@/lib/elevenlabs-service";

export function useElevenLabsTTS() {
  const [apiKey, setApiKey] = useState<string>("");
  const [isReady, setIsReady] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const key = await getElevenLabsApiKey();
      if (mounted && isMountedRef.current) {
        setApiKey(key);
        setIsReady(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const speak = async (text: string): Promise<void> => {
    if (!isMountedRef.current) return;
    await elevenLabsSpeak(text, apiKey);
  };

  return { speak, stopAudio, isReady, enabled: !!apiKey };
}
