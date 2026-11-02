const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GLANCE_INBOX_LIMIT,
  GlanceNotificationInbox,
  glanceNotificationFrom,
  layoutNotificationPanel,
  moreSummary,
  PANEL_ICON_SIZE,
  PANEL_PAD,
} = require("../.test-build/app/apps/glanceboard/notification-panel.js");

/** Monospace stand-in: 6px per character, 16px lines. */
const font = { lineHeight: 16, measureText: (text) => text.length * 6, getGlyph: () => ({ dwidthX: 6 }) };
const fonts = { header: font, title: font, body: font };
const WIDTH = 576;
/** Characters per wrapped line at WIDTH. */
const PER_LINE = Math.floor((WIDTH - 2 * PANEL_PAD) / 6);

function note(key, overrides = {}) {
  return { key, packageName: `pkg.${key}`, appName: `App ${key}`, title: `Title ${key}`, body: `Body ${key}`, postTime: 1000, ...overrides };
}

function android(overrides) {
  return {
    key: "k", packageName: "com.example", appName: "Example", title: "", text: "", bigText: "", subText: "",
    infoText: "", summaryText: "", category: "", lines: [], postTime: 5, when: 5, actions: [], ...overrides,
  };
}

test("inbox keeps the newest first and a repost replaces its earlier copy", () => {
  const inbox = new GlanceNotificationInbox();
  let changes = 0;
  inbox.onChanged(() => changes++);
  inbox.add(note("a"));
  inbox.add(note("b"));
  inbox.add(note("a", { body: "again", postTime: 2000 }));
  assert.deepEqual(inbox.unread().map((entry) => entry.key), ["a", "b"]);
  assert.equal(inbox.unread()[0].body, "again");
  assert.equal(changes, 3);
});

test("inbox drops the oldest beyond its limit", () => {
  const inbox = new GlanceNotificationInbox();
  for (let index = 0; index < GLANCE_INBOX_LIMIT + 3; index++) inbox.add(note(String(index)));
  assert.equal(inbox.unread().length, GLANCE_INBOX_LIMIT);
  assert.equal(inbox.unread()[0].key, String(GLANCE_INBOX_LIMIT + 2));
});

test("viewing removes only the copy that was shown; a newer repost stays unread", () => {
  const inbox = new GlanceNotificationInbox();
  inbox.add(note("a"));
  inbox.add(note("b"));
  const shown = inbox.unread().map(({ key, postTime }) => ({ key, postTime }));
  inbox.add(note("a", { postTime: 3000 }));
  inbox.markViewed(shown);
  assert.deepEqual(inbox.unread().map((entry) => [entry.key, entry.postTime]), [["a", 3000]]);
});

test("removing a withdrawn notification notifies only when it was there", () => {
  const inbox = new GlanceNotificationInbox();
  let changes = 0;
  inbox.add(note("a"));
  inbox.onChanged(() => changes++);
  inbox.remove("missing");
  inbox.remove("a");
  assert.equal(inbox.unread().length, 0);
  assert.equal(changes, 1);
});

test("an Android notification keeps its app, title and fullest text", () => {
  const entry = glanceNotificationFrom(android({ title: "Sam", text: "short", bigText: "the whole message" }));
  assert.deepEqual([entry.appName, entry.title, entry.body], ["Example", "Sam", "the whole message"]);
  // A body repeating the title is dropped; inbox-style lines join.
  assert.equal(glanceNotificationFrom(android({ title: "Same", text: "Same" })).body, "");
  assert.equal(glanceNotificationFrom(android({ lines: ["one", "two"] })).body, "one\ntwo");
  assert.equal(glanceNotificationFrom(android({ appName: "", packageName: "com.x" })).appName, "com.x");
});

test("a short notification gives a short panel", () => {
  const layout = layoutNotificationPanel(fonts, [note("a")], WIDTH, 300);
  assert.equal(layout.entries.length, 1);
  assert.equal(layout.entries[0].complete, true);
  assert.deepEqual(layout.more, []);
  // Header row, title line, body line.
  assert.equal(layout.height, PANEL_PAD + PANEL_ICON_SIZE + 2 + 16 + 2 + 16 + PANEL_PAD);
});

test("the panel grows with the message", () => {
  const short = layoutNotificationPanel(fonts, [note("a")], WIDTH, 400);
  const long = layoutNotificationPanel(fonts, [note("a", { body: "word ".repeat(PER_LINE) })], WIDTH, 400);
  assert.ok(long.entries[0].bodyLines.length > 1);
  assert.equal(long.height - short.height, (long.entries[0].bodyLines.length - 1) * 16);
});

test("a message too long for the display is cut to fit with an ellipsis", () => {
  const body = "word ".repeat(PER_LINE * 40);
  const layout = layoutNotificationPanel(fonts, [note("a", { body })], WIDTH, 200);
  const entry = layout.entries[0];
  assert.equal(entry.complete, false);
  assert.ok(layout.height <= 200);
  assert.ok(entry.bodyLines.length > 0);
  assert.ok(entry.bodyLines[entry.bodyLines.length - 1].endsWith("..."));
});

test("older notifications show whole or are summarised", () => {
  const notes = [note("a"), note("b"), note("c", { body: "word ".repeat(PER_LINE * 10) }), note("d")];
  const layout = layoutNotificationPanel(fonts, notes, WIDTH, 220);
  assert.deepEqual(layout.entries.map((entry) => entry.notification.key), ["a", "b"]);
  assert.ok(layout.entries.every((entry) => entry.complete));
  assert.deepEqual(layout.more.map((entry) => entry.key), ["c", "d"]);
  assert.ok(layout.height <= 220);
});

test("the summary names each app once", () => {
  assert.equal(moreSummary([note("a"), note("b"), note("c", { appName: "App a" })]), "+3 more: App a, App b");
});
