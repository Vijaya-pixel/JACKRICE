import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";
import ts from "typescript";

// Exercise the real TypeScript service without adding a test runner dependency.
const source = await readFile(new URL("../src/lib/elevenlabs-service.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { createElevenLabsService, getElevenLabsApiKey } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const original = {
  fetch: globalThis.fetch,
  Audio: globalThis.Audio,
  window: globalThis.window,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};
let audios;
let created;
let revoked;
let requests;
let play;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function audioResponse() {
  return { ok: true, status: 200, blob: async () => new Blob(["audio"]) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  audios = [];
  created = [];
  revoked = [];
  requests = [];
  play = () => Promise.resolve();
  globalThis.Audio = class {
    constructor(src) {
      this.src = src;
      this.paused = false;
      this.loaded = false;
      this.onended = null;
      this.onerror = null;
      audios.push(this);
    }
    play() {
      return play();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute(name) {
      if (name === "src") this.src = "";
    }
    load() {
      this.loaded = true;
    }
    end() {
      this.onended?.();
    }
    fail() {
      this.onerror?.();
    }
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return audioResponse();
  };
  URL.createObjectURL = () => {
    const url = `blob:test-${created.length}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
});

afterEach(() => {
  globalThis.fetch = original.fetch;
  if (original.Audio === undefined) delete globalThis.Audio;
  else globalThis.Audio = original.Audio;
  if (original.window === undefined) delete globalThis.window;
  else globalThis.window = original.window;
  URL.createObjectURL = original.createObjectURL;
  URL.revokeObjectURL = original.revokeObjectURL;
});

test("speech stays pending through playback and releases audio on completion", async () => {
  const player = createElevenLabsService();
  let settled = false;
  const speech = player.speak("Yes", "test-key").then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false);
  assert.equal(audios.length, 1);
  assert.match(requests[0].url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\//);
  assert.equal(requests[0].headers["xi-api-key"], "test-key");
  assert.equal(JSON.parse(requests[0].body).text, "Yes");
  audios[0].end();
  await speech;
  assert.equal(settled, true);
  assert.equal(audios[0].src, "");
  assert.equal(audios[0].loaded, true);
  assert.deepEqual(revoked, created);
  player.stopAudio();
  assert.equal(revoked.length, 1);
});

test("stop settles immediately and late fetch responses never play", async () => {
  const response = deferred();
  let signal;
  globalThis.fetch = (_url, options) => {
    signal = options.signal;
    return response.promise; // Deliberately ignore AbortSignal.
  };
  const player = createElevenLabsService();
  const cancelled = assert.rejects(player.speak("Yes", "test-key"), { name: "AbortError" });
  player.stopAudio();
  await cancelled;
  assert.equal(signal.aborted, true);
  response.resolve(audioResponse());
  await flush();
  assert.equal(audios.length, 0);
  assert.equal(created.length, 0);
});

test("newest selection wins when fetch responses arrive in reverse order", async () => {
  const responses = [deferred(), deferred()];
  let call = 0;
  globalThis.fetch = (_url, options) => {
    requests.push(options);
    return responses[call++].promise;
  };
  const player = createElevenLabsService();
  const first = assert.rejects(player.speak("Yes", "test-key"), { name: "AbortError" });
  const second = player.speak("No", "test-key");
  await first;
  assert.equal(requests[0].signal.aborted, true);
  responses[1].resolve(audioResponse());
  await flush();
  assert.equal(audios.length, 1);
  responses[0].resolve(audioResponse());
  await flush();
  assert.equal(audios.length, 1);
  assert.equal(audios[0].paused, false);
  audios[0].end();
  await second;
  assert.deepEqual(revoked, created);
});

test("cancellation during blob decoding cannot create stale audio", async () => {
  const blob = deferred();
  globalThis.fetch = async () => ({ ok: true, status: 200, blob: () => blob.promise });
  const player = createElevenLabsService();
  const cancelled = assert.rejects(player.speak("Yes", "test-key"), { name: "AbortError" });
  await flush();
  player.stopAudio();
  await cancelled;
  blob.resolve(new Blob(["audio"]));
  await flush();
  assert.deepEqual(created, []);
  assert.deepEqual(audios, []);
});

test("stopping while play is pending cleans up and blocks a late play resolution", async () => {
  const playing = deferred();
  play = () => playing.promise;
  const player = createElevenLabsService();
  const cancelled = assert.rejects(player.speak("Yes", "test-key"), { name: "AbortError" });
  await flush();
  player.stopAudio();
  await cancelled;
  assert.deepEqual(revoked, created);
  assert.equal(audios[0].src, "");
  assert.equal(audios[0].onended, null);
  assert.equal(audios[0].onerror, null);
  playing.resolve();
  await flush();
  assert.equal(audios[0].paused, true);
  assert.equal(revoked.length, 1);
});

test("a new utterance immediately stops and releases current playback", async () => {
  const player = createElevenLabsService();
  const first = assert.rejects(player.speak("First", "test-key"), { name: "AbortError" });
  await flush();
  const oldEnded = audios[0].onended;
  const second = player.speak("Second", "test-key");
  await first;
  await flush();
  assert.equal(audios[0].paused, true);
  assert.equal(audios.length, 2);
  oldEnded(); // A stale callback cannot stop the newer request.
  assert.equal(audios[1].paused, false);
  audios[1].end();
  await second;
  assert.deepEqual(revoked, created);
});

test("play rejection and audio errors release URLs and reject with safe messages", async () => {
  const player = createElevenLabsService();
  play = () => Promise.reject(new Error("secret-test-key"));
  await assert.rejects(player.speak("Yes", "test-key"), (error) => {
    assert.match(error.message, /playback was blocked or failed/);
    assert.doesNotMatch(error.message, /secret-test-key/);
    return true;
  });
  assert.deepEqual(revoked, created);
  play = () => Promise.resolve();
  const failed = assert.rejects(player.speak("No", "test-key"), /audio could not be played/);
  await flush();
  audios[1].fail();
  await failed;
  assert.deepEqual(revoked, created);
  assert.equal(audios[1].src, "");
});

test("API and network failures do not expose response bodies or credentials", async () => {
  const player = createElevenLabsService();
  for (const status of [401, 403, 429, 500]) {
    globalThis.fetch = async () => ({
      ok: false,
      status,
      statusText: "secret-test-key",
      json: async () => {
        throw new Error("Must not read untrusted error bodies");
      },
    });
    await assert.rejects(player.speak("Yes", "secret-test-key"), (error) => {
      assert.match(error.message, /ElevenLabs/);
      assert.doesNotMatch(error.message, /secret-test-key/);
      return true;
    });
  }
  globalThis.fetch = async () => {
    throw new Error("secret-test-key");
  };
  await assert.rejects(player.speak("Yes", "secret-test-key"), /Could not connect to ElevenLabs/);
  assert.equal(audios.length, 0);
});

test("long summaries play bounded chunks in sequence and resolve only at the end", async () => {
  const player = createElevenLabsService();
  const summary = "Patient answer. ".repeat(600).trim();
  let settled = false;
  const speech = player.speak(summary, "test-key").then(() => {
    settled = true;
  });
  await flush();
  assert.equal(requests.length, 1);
  audios[0].end();
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(settled, false);
  audios[1].end();
  await flush();
  assert.equal(requests.length, 3);
  assert.equal(settled, false);
  audios[2].end();
  await speech;
  const chunks = requests.map((request) => JSON.parse(request.body).text);
  assert.ok(chunks.every((chunk) => chunk.length <= 4_000));
  assert.equal(chunks.join(" "), summary);
  assert.deepEqual(revoked, created);
});

test("stopping a long summary prevents later chunks from being requested", async () => {
  const player = createElevenLabsService();
  const cancelled = assert.rejects(player.speak("Answer. ".repeat(1200), "test-key"), {
    name: "AbortError",
  });
  await flush();
  assert.equal(requests.length, 1);
  player.stopAudio();
  await cancelled;
  await flush();
  assert.equal(requests.length, 1);
  assert.deepEqual(revoked, created);
});

test("empty inputs and absent credentials skip speech requests", async () => {
  const player = createElevenLabsService();
  await player.speak("   ", "test-key");
  await player.speak("Yes", "   ");
  assert.equal(requests.length, 0);
  delete globalThis.window;
  assert.equal(await getElevenLabsApiKey(), "");
  globalThis.window = { tacit: { getElevenLabsApiKey: async () => "  test-key  " } };
  assert.equal(await getElevenLabsApiKey(), "test-key");
  globalThis.window.tacit.getElevenLabsApiKey = async () => {
    throw new Error("secret-key");
  };
  assert.equal(await getElevenLabsApiKey(), "");
});
