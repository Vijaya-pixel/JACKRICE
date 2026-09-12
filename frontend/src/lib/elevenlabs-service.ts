/**
 * elevenLabsService.ts — Eleven Labs text-to-speech for the React frontend.
 * Works in both Electron (with IPC) and plain browser.
 */

let currentAudio: HTMLAudioElement | null = null;

/**
 * Get the Eleven Labs API key from the Electron bridge, or empty string in browser.
 */
export async function getElevenLabsApiKey(): Promise<string> {
  if (typeof window !== "undefined" && window.tacit?.getElevenLabsApiKey) {
    try {
      return await window.tacit.getElevenLabsApiKey();
    } catch (e) {
      console.error("[elevenLabsService] Failed to get API key from Electron:", e);
      return "";
    }
  }
  return "";
}

/**
 * Stop any currently playing audio.
 */
export function stopAudio(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
}

/**
 * Convert text to speech using Eleven Labs and play it.
 * @param text The text to speak
 * @param apiKey The Eleven Labs API key (if empty, does nothing)
 */
export async function speak(text: string, apiKey: string): Promise<void> {
  if (!text || typeof text !== "string" || !apiKey) {
    if (!apiKey) console.warn("[elevenLabsService] No API key; TTS disabled");
    return;
  }

  try {
    console.log(`[elevenLabsService] Speaking: "${text}"`);

    // Stop any currently playing audio
    stopAudio();

    const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
    const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
    // const VOICE_ID = 'EXAVITQu4EsNXXTT9ejl';  // Bella (alternative)

    // Call the Eleven Labs API
    const response = await fetch(`${ELEVENLABS_API_BASE}/text-to-speech/${VOICE_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      const error = (await response.json()) as { detail?: { message?: string } };
      throw new Error(
        `Eleven Labs API error: ${error.detail?.message || response.statusText}`
      );
    }

    // Get the audio blob
    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);

    // Create and play audio
    currentAudio = new Audio(audioUrl);
    currentAudio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
    };
    currentAudio.onerror = (e) => {
      console.error("[elevenLabsService] Audio playback error:", e);
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
    };

    await currentAudio.play();
    console.log(`[elevenLabsService] Playing audio for: "${text}"`);
  } catch (error) {
    console.error("[elevenLabsService] Error:", error instanceof Error ? error.message : error);
    // Don't throw; let the app continue without audio
  }
}
