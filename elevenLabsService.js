/**
 * elevenLabsService.js — Eleven Labs text-to-speech integration.
 * Converts selected text to speech and plays it back.
 *
 * USAGE:
 *   const tts = createElevenLabsService({ apiKey });
 *   await tts.speak('Yes');  // converts text to speech and plays it
 */

export function createElevenLabsService({ apiKey }) {
  if (!apiKey) {
    console.warn('[elevenLabsService] No API key provided; TTS disabled');
    return { speak: async () => {} };
  }

  const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';
  // Use the default voice (Rachel). Can be customized to other voice IDs:
  // https://elevenlabs.io/docs/api-reference/get-voices
  const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel
  // const VOICE_ID = 'EXAVITQu4EsNXXTT9ejl';  // Bella (alternative)

  let currentAudio = null;

  /**
   * Stop any currently playing audio.
   */
  function stopAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
  }

  /**
   * Convert text to speech and play it.
   * @param {string} text - The text to speak
   * @returns {Promise<void>}
   */
  async function speak(text) {
    if (!text || typeof text !== 'string') {
      console.warn('[elevenLabsService] Invalid text:', text);
      return;
    }

    try {
      console.log(`[elevenLabsService] Speaking: "${text}"`);

      // Stop any currently playing audio
      stopAudio();

      // Call the Eleven Labs API
      const response = await fetch(
        `${ELEVENLABS_API_BASE}/text-to-speech/${VOICE_ID}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_multilingual_v2', // or 'eleven_monolingual_v1' for English only
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Eleven Labs API error: ${error.detail?.message || response.statusText}`);
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
        console.error('[elevenLabsService] Audio playback error:', e);
        URL.revokeObjectURL(audioUrl);
        currentAudio = null;
      };

      await currentAudio.play();
      console.log(`[elevenLabsService] Playing audio for: "${text}"`);
    } catch (error) {
      console.error('[elevenLabsService] Error:', error.message);
      throw error;
    }
  }

  return { speak, stopAudio };
}
