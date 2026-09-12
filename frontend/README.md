# Tacit Blink UI

Build a visual UI prototype for an app called Tacit — a contactless

communication tool for ICU/paralysis patients who can only blink. This is

a DESIGN PROTOTYPE ONLY: no real webcam tracking, no real AI calls, no real

text-to-speech. Simulate the "blink selects" interaction with the spacebar

or a click, purely to demonstrate the interaction flow and visual design.

SCREENS TO BUILD:

1. Calibration screen

   - A simple circular ring/progress indicator that visually fills up

     (simulate with a CSS animation, no real camera logic needed)

   - Calm, reassuring copy: "Getting to know your blink..."

   - Auto-advances to the Yes/No screen after the animation completes

2. Yes/No screen (this is the onboarding — no separate tutorial)

   - Two large, high-contrast boxes: "Yes" and "No"

   - A highlight visually sweeps back and forth between them on a timed

     interval (simulate with CSS/JS, e.g. every 1.5 seconds)

   - Pressing spacebar (standing in for a blink) "selects" whichever box

     is currently highlighted, with a clear visual confirmation (a satisfying

     fill/pulse animation on the selected box)

3. High-frequency needs board

   - A grid of common needs as large tappable-looking cards: Pain, Thirsty,

     Nurse, Uncomfortable, Family, Yes, No, More time

   - Same scanning-highlight mechanic sweeping through the grid

   - Same spacebar-to-select simulation

4. Frequency-ordered scanning keyboard

   - Letters laid out NOT in QWERTY order, but by frequency of use in

     English (e.g. E, T, A, O, I, N... first)

   - The scan highlight moves through letters one at a time

   - An "undo" option always visible/reachable in the scan cycle

   - Show a text field building up the message as letters are selected

   - Below the text field, show 2-3 mock "suggested phrase" cards

     (hardcoded fake suggestions, not real AI) that can also be

     selected via the same scanning mechanic

5. Message confirmed / spoken screen

   - Shows the finished message large on screen

   - A visual "speaking" indicator (animated sound-wave bars) to represent

     where text-to-speech playback would happen — no real audio needed

6. Clinician panel (separate view, toggle-able, more data-dense styling)

   - A live-looking line chart (use fake/random data updating on an

     interval) representing an eye-aspect-ratio signal over time, with a

     horizontal threshold line

   - A "false activations" counter (mock number)

   - A "tracking quality: good" status indicator

   - Readout of mock calibration values

DESIGN DIRECTION:

- Calm, high-contrast, unhurried — this is for someone in a vulnerable

  medical situation, avoid anything flashy or jarring

- Large, clear visual targets throughout the patient-facing screens

- The clinician panel can look more technical/dense, clearly a distinct

  mode from the patient-facing screens

- Dark mode friendly

- Add a small footer note: "Prototype — blink detection simulated via

  spacebar for demo purposes"

Do not wire up any real camera access, MediaPipe, Gemini, or ElevenLabs

calls. Every "AI suggestion" and "detected blink" should be mocked/hardcoded

or timer-driven, purely so the interaction flow and visual design can be

reviewed and clicked through.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/e4e7d789-c68a-431c-b732-d076861cd129).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
