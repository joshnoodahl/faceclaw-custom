/**
 * Recognises a ring triple tap. The ring has no such gesture of its own: it
 * reports a quick third tap as a double tap followed by a single tap. The
 * double tap acts as usual (back, screen off, wake); a ring tap soon after it
 * is the triple tap and is consumed instead of acting as a tap.
 *
 * "Soon" is measured from the double tap to the third touch-down (the
 * ring-press the ring sends at once) when there is one, since the ring only
 * reports the tap itself once it has waited out a possible double tap.
 * Without a touch-down, the tap itself must arrive within the window.
 *
 * No NativeScript imports: this module is compiled and run under plain node
 * by tests/triple-tap.test.cjs.
 */
import { type InputEvent } from "./gestures";

/** Longest gap from the double tap to the third tap's touch-down. */
export const TRIPLE_TAP_WINDOW_MS = 600;

export class TripleTapDetector {
  /** The window after a ring double tap, or 0 when none is open. */
  private armedUntilMs = 0;
  /** A ring touch-down began inside the window; its tap completes the triple. */
  private thirdTouch = false;

  /** Feed every input in order; true for the tap that completes a triple tap. */
  observe(event: InputEvent, nowMs: number): boolean {
    const ring = "source" in event && event.source === "ring";
    switch (event.type) {
      case "double-click":
        if (!ring) break;
        this.armedUntilMs = nowMs + TRIPLE_TAP_WINDOW_MS;
        this.thirdTouch = false;
        return false;
      case "ring-press":
        // A touch-down precedes every gesture; only the window decides.
        if (ring && this.armedUntilMs && nowMs <= this.armedUntilMs) this.thirdTouch = true;
        return false;
      case "click": {
        const triple = ring && this.armedUntilMs !== 0 && (this.thirdTouch || nowMs <= this.armedUntilMs);
        this.reset();
        return triple;
      }
    }
    this.reset();
    return false;
  }

  reset(): void {
    this.armedUntilMs = 0;
    this.thirdTouch = false;
  }
}
