import { useEffect, useRef } from "react";

/**
 * Fires onSelect() for a deliberate "choose the highlighted option" gesture.
 * Drop-in replacement for the old useSpaceSelect(onSelect) in routes/app.tsx.
 *
 *  - Electron: also wired to a real blink 'select' event from blinkEngine.js,
 *    forwarded through the hidden engine-host window (see
 *    ../../../engineHostRenderer.js and window.tacit.onEngineEvent).
 *  - Everywhere, including inside Electron: the spacebar still works. It's
 *    kept as a manual override rather than replaced outright — useful for
 *    testing without a working camera, on either side of the bridge.
 */
export function useBlinkInput(onSelect: () => void) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      event.preventDefault();
      onSelectRef.current();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  useEffect(() => {
    if (!window.tacit) return; // browser mode: spacebar above is the only input
    const unsubscribe = window.tacit.onEngineEvent((event) => {
      if (event.type === "select") onSelectRef.current();
    });
    return unsubscribe;
  }, []);
}
