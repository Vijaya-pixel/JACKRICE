/** ElevenLabs speech playback for the Electron frontend. */

const SPEECH_ENDPOINT =
  "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128";
const MAX_CHUNK_LENGTH = 4_000;

/** Keys are supplied by Electron; browser previews have no configured key. */
export async function getElevenLabsApiKey(): Promise<string> {
  try {
    if (typeof window !== "undefined" && window.tacit?.getElevenLabsApiKey) {
      const key = await window.tacit.getElevenLabsApiKey();
      return typeof key === "string" ? key.trim() : "";
    }
  } catch {
    // Do not log bridge failures, which may contain credential details.
  }
  return "";
}

class SpeechError extends Error {}

function apiError(status: number): SpeechError {
  if (status === 401 || status === 403) {
    return new SpeechError("ElevenLabs access was denied. Check the API key and its permissions.");
  }
  if (status === 429) {
    return new SpeechError("ElevenLabs is busy or the speech quota is exhausted. Try again later.");
  }
  return new SpeechError(`ElevenLabs could not generate speech (HTTP ${status}). Try again.`);
}

/** Keep long session summaries within the model's per-request text limit. */
function splitText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > MAX_CHUNK_LENGTH) {
    const prefix = remaining.slice(0, MAX_CHUNK_LENGTH + 1);
    const boundary = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\n"));
    const end = boundary > MAX_CHUNK_LENGTH / 2 ? boundary : MAX_CHUNK_LENGTH;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

interface SpeechRequest {
  controller: AbortController;
  audio: HTMLAudioElement | null;
  url: string | null;
  resolvePlayback: (() => void) | null;
  finish: (error?: Error) => void;
}

function releaseAudio(request: SpeechRequest): void {
  const audio = request.audio;
  request.audio = null;
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (request.url) {
    URL.revokeObjectURL(request.url);
    request.url = null;
  }
  const resolve = request.resolvePlayback;
  request.resolvePlayback = null;
  resolve?.();
}

/**
 * One player per hook. A new utterance replaces the previous utterance, including
 * requests still downloading. speak() settles after playback ends or is stopped.
 * API reference: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 */
export function createElevenLabsService() {
  let active: SpeechRequest | null = null;

  function stopAudio(): void {
    if (!active) return;
    const request = active;
    request.controller.abort();
    request.finish(new DOMException("Speech stopped.", "AbortError"));
  }

  function speak(text: string, apiKey: string): Promise<void> {
    stopAudio();
    const chunks = splitText(text);
    if (!chunks.length || !apiKey.trim()) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const request: SpeechRequest = {
        controller: new AbortController(),
        audio: null,
        url: null,
        resolvePlayback: null,
        finish(error) {
          if (finished) return;
          finished = true;
          if (active === request) active = null;
          releaseAudio(request);
          if (error) reject(error);
          else resolve();
        },
      };
      active = request;
      const isCurrent = () => active === request && !request.controller.signal.aborted;

      async function generateAndPlay(): Promise<void> {
        for (const chunk of chunks) {
          let response: Response;
          try {
            response = await fetch(SPEECH_ENDPOINT, {
              method: "POST",
              signal: request.controller.signal,
              headers: {
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
                "xi-api-key": apiKey,
              },
              body: JSON.stringify({
                text: chunk,
                model_id: "eleven_multilingual_v2",
                voice_settings: { stability: 0.5, similarity_boost: 0.75 },
              }),
            });
          } catch {
            throw new SpeechError(
              "Could not connect to ElevenLabs. Check your connection and try again.",
            );
          }
          // Check ownership even when a transport does not honor AbortSignal.
          if (!isCurrent()) return;
          if (!response.ok) throw apiError(response.status);
          const blob = await response.blob();
          if (!isCurrent()) return;

          request.url = URL.createObjectURL(blob);
          await new Promise<void>((playbackEnded, playbackFailed) => {
            request.resolvePlayback = playbackEnded;
            const audio = new Audio(request.url!);
            request.audio = audio;
            audio.onended = () => releaseAudio(request);
            audio.onerror = () =>
              playbackFailed(new SpeechError("Speech audio could not be played. Try again."));
            void audio.play().then(
              () => {
                if (!isCurrent()) audio.pause();
              },
              () =>
                playbackFailed(
                  new SpeechError("Speech playback was blocked or failed. Try again."),
                ),
            );
          });
          if (!isCurrent()) return;
        }
        request.finish();
      }

      void generateAndPlay().catch((error: unknown) => {
        request.finish(
          error instanceof SpeechError
            ? error
            : new SpeechError("Could not play speech. Please try again."),
        );
      });
    });
  }

  return { speak, stopAudio };
}
