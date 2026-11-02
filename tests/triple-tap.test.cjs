const test = require("node:test");
const assert = require("node:assert/strict");

const { TRIPLE_TAP_WINDOW_MS, TripleTapDetector } = require("../.test-build/app/ui/triple-tap.js");

const T0 = 1_000_000;
const press = { type: "ring-press", source: "ring" };
const tap = { type: "click", source: "ring" };
const doubleTap = { type: "double-click", source: "ring" };

test("a double tap followed quickly by a tap is a triple tap; the double tap itself is not", () => {
  const detector = new TripleTapDetector();
  assert.equal(detector.observe(doubleTap, T0), false);
  assert.equal(detector.observe(tap, T0 + 300), true);
  // Used up: another tap is just a tap.
  assert.equal(detector.observe(tap, T0 + 400), false);
});

test("the third touch-down inside the window counts even when the tap is reported later", () => {
  const detector = new TripleTapDetector();
  detector.observe(doubleTap, T0);
  assert.equal(detector.observe(press, T0 + TRIPLE_TAP_WINDOW_MS - 50), false);
  assert.equal(detector.observe(tap, T0 + TRIPLE_TAP_WINDOW_MS + 300), true);
});

test("a tap after the window is an ordinary tap", () => {
  const detector = new TripleTapDetector();
  detector.observe(doubleTap, T0);
  detector.observe(press, T0 + TRIPLE_TAP_WINDOW_MS + 1);
  assert.equal(detector.observe(tap, T0 + TRIPLE_TAP_WINDOW_MS + 300), false);
});

test("a single tap, or a tap then a double tap, is never a triple tap", () => {
  const detector = new TripleTapDetector();
  assert.equal(detector.observe(tap, T0), false);
  assert.equal(detector.observe(doubleTap, T0 + 100), false);
});

test("any other gesture in between cancels it", () => {
  const detector = new TripleTapDetector();
  detector.observe(doubleTap, T0);
  detector.observe({ type: "scroll-down" }, T0 + 100);
  assert.equal(detector.observe(tap, T0 + 200), false);
});

test("only the ring counts", () => {
  const detector = new TripleTapDetector();
  detector.observe({ type: "double-click", source: "watch" }, T0);
  assert.equal(detector.observe(tap, T0 + 100), false);
  detector.observe(doubleTap, T0 + 200);
  assert.equal(detector.observe({ type: "click", source: "right-arm" }, T0 + 300), false);
});
