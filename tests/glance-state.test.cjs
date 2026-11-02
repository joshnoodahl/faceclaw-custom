const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GLANCE_BANNER_MS,
  GLANCE_HIDDEN,
  GLANCE_TIMEOUT_MS,
  glanceEventForGesture,
  reduceGlance,
} = require("../.test-build/app/g2/glance-state.js");

const T0 = 1_000_000;

test("a press shows the board and arms the auto-hide timer", () => {
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0);
  assert.deepEqual(shown, { visible: true, holding: false, hideAtMs: T0 + GLANCE_TIMEOUT_MS });
  // A timer firing early is ignored; on time it hides.
  assert.equal(reduceGlance(shown, { type: "timeout" }, T0 + GLANCE_TIMEOUT_MS - 1), shown);
  assert.deepEqual(reduceGlance(shown, { type: "timeout" }, T0 + GLANCE_TIMEOUT_MS), GLANCE_HIDDEN);
});

test("a further press renews the timer from the new press", () => {
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0);
  const renewed = reduceGlance(shown, { type: "press" }, T0 + 2000);
  assert.equal(renewed.hideAtMs, T0 + 2000 + GLANCE_TIMEOUT_MS);
  assert.equal(reduceGlance(renewed, { type: "timeout" }, T0 + GLANCE_TIMEOUT_MS), renewed);
});

test("a hold shows the board without a timer and the release hides it", () => {
  const held = reduceGlance(GLANCE_HIDDEN, { type: "hold" }, T0);
  assert.deepEqual(held, { visible: true, holding: true, hideAtMs: null });
  assert.equal(reduceGlance(held, { type: "timeout" }, T0 + 60_000), held);
  // A tap mid-hold neither hides nor starts a timer.
  assert.equal(reduceGlance(held, { type: "press" }, T0 + 500), held);
  assert.deepEqual(reduceGlance(held, { type: "release" }, T0 + 1000), GLANCE_HIDDEN);
});

test("a release that was not holding the board is ignored", () => {
  assert.equal(reduceGlance(GLANCE_HIDDEN, { type: "release" }, T0), GLANCE_HIDDEN);
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0);
  assert.equal(reduceGlance(shown, { type: "release" }, T0 + 100), shown);
});

test("dismiss hides from any state", () => {
  const held = reduceGlance(GLANCE_HIDDEN, { type: "hold" }, T0);
  assert.deepEqual(reduceGlance(held, { type: "dismiss" }, T0), GLANCE_HIDDEN);
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0);
  assert.deepEqual(reduceGlance(shown, { type: "dismiss" }, T0), GLANCE_HIDDEN);
});

test("gesture mapping: taps and head-tilt press, both long-press gestures hold, double-tap dismisses only a visible board", () => {
  assert.deepEqual(glanceEventForGesture("click", false), { type: "press" });
  assert.deepEqual(glanceEventForGesture("head-tilt", false), { type: "press" });
  assert.deepEqual(glanceEventForGesture("long-press", false), { type: "hold" });
  assert.deepEqual(glanceEventForGesture("short-then-long-press", false), { type: "hold" });
  assert.deepEqual(glanceEventForGesture("short-then-long-press", true), { type: "hold" });
  assert.deepEqual(glanceEventForGesture("long-press-release", true), { type: "release" });
  assert.equal(glanceEventForGesture("double-click", false), null);
  assert.deepEqual(glanceEventForGesture("double-click", true), { type: "dismiss" });
  assert.equal(glanceEventForGesture("scroll-up", true), null);
});

test("the press timeout is the host's when supplied", () => {
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0, 10_000);
  assert.equal(shown.hideAtMs, T0 + 10_000);
  assert.equal(reduceGlance(shown, { type: "timeout" }, T0 + GLANCE_TIMEOUT_MS), shown);
  assert.deepEqual(reduceGlance(shown, { type: "timeout" }, T0 + 10_000), GLANCE_HIDDEN);
});

test("a notification banner shows on its own timer and hides like a press", () => {
  const banner = reduceGlance(GLANCE_HIDDEN, { type: "banner" }, T0, 10_000);
  assert.deepEqual(banner, { visible: true, holding: false, hideAtMs: T0 + GLANCE_BANNER_MS, banner: true });
  assert.equal(reduceGlance(banner, { type: "timeout" }, T0 + GLANCE_BANNER_MS - 1), banner);
  assert.deepEqual(reduceGlance(banner, { type: "timeout" }, T0 + GLANCE_BANNER_MS), GLANCE_HIDDEN);
  // A newer notification renews the banner.
  assert.equal(reduceGlance(banner, { type: "banner" }, T0 + 1000).hideAtMs, T0 + 1000 + GLANCE_BANNER_MS);
});

test("a tap or hold over the banner opens the board", () => {
  const banner = reduceGlance(GLANCE_HIDDEN, { type: "banner" }, T0);
  assert.deepEqual(reduceGlance(banner, { type: "press" }, T0 + 500, 5000),
    { visible: true, holding: false, hideAtMs: T0 + 5500 });
  assert.deepEqual(reduceGlance(banner, { type: "hold" }, T0 + 500), { visible: true, holding: true, hideAtMs: null });
  assert.deepEqual(reduceGlance(banner, { type: "dismiss" }, T0 + 500), GLANCE_HIDDEN);
});

test("a notification while the board is up leaves the board as it is", () => {
  const shown = reduceGlance(GLANCE_HIDDEN, { type: "press" }, T0);
  assert.equal(reduceGlance(shown, { type: "banner" }, T0 + 100), shown);
  const held = reduceGlance(GLANCE_HIDDEN, { type: "hold" }, T0);
  assert.equal(reduceGlance(held, { type: "banner" }, T0 + 100), held);
});
