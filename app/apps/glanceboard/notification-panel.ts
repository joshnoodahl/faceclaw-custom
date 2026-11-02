/**
 * Notifications on the Glanceboard: the unread inbox, the banner that shows
 * while asleep when one arrives, and the panel the board grows at its top to
 * carry them in full. The board's own geometry is fixed by its layout; the
 * panel adapts to the text, from one header line up to most of the display.
 *
 * No NativeScript imports: this module is compiled and run under plain node
 * by tests/glanceboard-notifications.test.cjs. Fonts and icons come in from
 * the caller (glance-notifications.ts).
 */
import { GrayImage, type UiFont } from "../../graphics/image";
import { truncateText, wrapText, type WrapFont } from "../../graphics/textwrap";
import { type AndroidNotification } from "../../native/notification-types";

/** What the board keeps of a notification posted while asleep. */
export type GlanceNotification = {
  key: string;
  packageName: string;
  appName: string;
  title: string;
  body: string;
  postTime: number;
};

/** Oldest unread entries drop once the inbox holds this many. */
export const GLANCE_INBOX_LIMIT = 20;

export function glanceNotificationFrom(notification: AndroidNotification): GlanceNotification {
  const appName = notification.appName || notification.packageName || "Notification";
  const title = notification.title || notification.customText?.join(" ") || "";
  const body = notification.bigText || notification.text || notification.lines.join("\n") ||
    notification.summaryText || "";
  return {
    key: notification.key,
    packageName: notification.packageName,
    appName,
    title,
    body: body === title ? "" : body,
    postTime: notification.postTime || Date.now(),
  };
}

/**
 * Notifications posted while asleep that the board has not yet shown in
 * full. An entry leaves once the board has painted it whole and then hidden
 * (markViewed), or when the phone withdraws it (remove). A repost under the
 * same key (a messaging app adding a message) replaces it and counts as new.
 */
export class GlanceNotificationInbox {
  private entries: GlanceNotification[] = [];
  private readonly listeners = new Set<() => void>();

  /** Newest first. */
  unread(): readonly GlanceNotification[] {
    return this.entries;
  }

  add(notification: GlanceNotification): void {
    this.entries = [notification, ...this.entries.filter((entry) => entry.key !== notification.key)]
      .slice(0, GLANCE_INBOX_LIMIT);
    this.changed();
  }

  remove(key: string): void {
    const next = this.entries.filter((entry) => entry.key !== key);
    if (next.length === this.entries.length) return;
    this.entries = next;
    this.changed();
  }

  /**
   * The board showed these (as painted, matching postTime so a repost that
   * arrived after the paint stays unread).
   */
  markViewed(shown: readonly Pick<GlanceNotification, "key" | "postTime">[]): void {
    if (!shown.length) return;
    const next = this.entries.filter((entry) =>
      !shown.some((seen) => seen.key === entry.key && seen.postTime === entry.postTime));
    if (next.length === this.entries.length) return;
    this.entries = next;
    this.changed();
  }

  clear(): void {
    if (!this.entries.length) return;
    this.entries = [];
    this.changed();
  }

  /** Returns an unsubscribe function. */
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
}

export type PanelFont = WrapFont & { readonly lineHeight: number };
export type PanelFonts = { header: PanelFont; title: PanelFont; body: PanelFont };

export const PANEL_PAD = 8;
/** App icon size in the header row (NOTIFICATION_ICON_SIZE). */
export const PANEL_ICON_SIZE = 25;
const ICON_GAP = 6;
/** Rows between one notification and the next (a hairline sits in the middle). */
const ENTRY_GAP = 9;
const LINE_GAP = 2;

export type PanelEntry = {
  notification: GlanceNotification;
  /** Wrapped title and body lines, already cut to fit (the last ends in "..." when cut). */
  titleLines: string[];
  bodyLines: string[];
  /** Top of the entry, from the top of the panel. */
  top: number;
  /** Every line fit: the entry counts as read once the board hides. */
  complete: boolean;
};

export type PanelLayout = {
  width: number;
  height: number;
  entries: PanelEntry[];
  /** Unread notifications left off the panel, summarised on its last line. */
  more: GlanceNotification[];
  /** Top of the "+N more" line, when there is one. */
  moreTop: number;
};

function headerHeight(fonts: PanelFonts): number {
  return Math.max(PANEL_ICON_SIZE, fonts.header.lineHeight);
}

function entryHeight(fonts: PanelFonts, titleLines: number, bodyLines: number): number {
  return headerHeight(fonts) + LINE_GAP +
    titleLines * fonts.title.lineHeight + (titleLines && bodyLines ? LINE_GAP : 0) +
    bodyLines * fonts.body.lineHeight;
}

/**
 * Lay out the unread notifications, newest first, within `maxHeight`. The
 * newest always appears, cut short when it is too long on its own; each
 * older one appears only whole. Whatever is left over becomes a "+N more"
 * line naming the apps.
 */
export function layoutNotificationPanel(
  fonts: PanelFonts,
  notifications: readonly GlanceNotification[],
  width: number,
  maxHeight: number,
): PanelLayout {
  const textWidth = width - 2 * PANEL_PAD;
  const moreHeight = fonts.header.lineHeight + ENTRY_GAP;
  const entries: PanelEntry[] = [];
  let y = PANEL_PAD;
  let index = 0;
  for (; index < notifications.length; index++) {
    const notification = notifications[index]!;
    const titleLines = notification.title ? wrapText(fonts.title, notification.title, textWidth) : [];
    const bodyLines = notification.body ? wrapText(fonts.body, notification.body.trim(), textWidth) : [];
    const top = y + (entries.length ? ENTRY_GAP : 0);
    const left = notifications.length - index - 1;
    // Room for the "+N more" line too, unless this is the last notification.
    const room = maxHeight - PANEL_PAD - top - (left ? moreHeight : 0);
    const full = entryHeight(fonts, titleLines.length, bodyLines.length);
    if (full <= room) {
      entries.push({ notification, titleLines, bodyLines, top, complete: true });
      y = top + full;
      continue;
    }
    if (entries.length) break;
    // The newest is too long on its own: keep what fits, title first.
    const fitted = fitLines(fonts, titleLines, bodyLines, maxHeight - PANEL_PAD - top - (left ? moreHeight : 0), textWidth);
    entries.push({ notification, ...fitted, top, complete: false });
    y = top + entryHeight(fonts, fitted.titleLines.length, fitted.bodyLines.length);
    index++;
    break;
  }
  const more = notifications.slice(index);
  const moreTop = y + ENTRY_GAP;
  if (more.length) y = moreTop + fonts.header.lineHeight;
  return { width, height: Math.min(maxHeight, y + PANEL_PAD), entries, more, moreTop };
}

function fitLines(
  fonts: PanelFonts,
  titleLines: string[],
  bodyLines: string[],
  room: number,
  textWidth: number,
): { titleLines: string[]; bodyLines: string[] } {
  const titles = titleLines.slice();
  const bodies = bodyLines.slice();
  while (bodies.length && entryHeight(fonts, titles.length, bodies.length) > room) bodies.pop();
  while (titles.length > 1 && entryHeight(fonts, titles.length, bodies.length) > room) titles.pop();
  // Mark the cut on the last line still showing.
  const ellipsize = (font: PanelFont, lines: string[]) => {
    const last = lines.length - 1;
    lines[last] = truncateText(font, `${lines[last]!.trimEnd()}...`, textWidth);
  };
  if (bodies.length) {
    if (bodies.length < bodyLines.length) ellipsize(fonts.body, bodies);
  } else if (titles.length && (bodyLines.length || titles.length < titleLines.length)) {
    ellipsize(fonts.title, titles);
  }
  return { titleLines: titles, bodyLines: bodies };
}

/** "+2 more: Slack, Gmail", each app named once. */
export function moreSummary(more: readonly GlanceNotification[]): string {
  const apps = Array.from(new Set(more.map((entry) => entry.appName)));
  return `+${more.length} more: ${apps.join(", ")}`;
}

export type DrawFonts = { header: UiFont; title: UiFont; body: UiFont };
export type IconFor = (notification: GlanceNotification) => GrayImage | null;

const HEADER_VALUE = 170;
const TITLE_VALUE = 230;
const BODY_VALUE = 200;
const RULE_VALUE = 40;

function formatTime(postTime: number): string {
  const date = new Date(postTime);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Paint a laid-out panel into its own canvas. */
export function paintNotificationPanel(
  layout: PanelLayout,
  fonts: DrawFonts,
  iconFor: IconFor,
): GrayImage {
  const image = new GrayImage(layout.width, layout.height, 0);
  const right = layout.width - PANEL_PAD;
  const rowHeight = headerHeight(fonts);
  layout.entries.forEach((entry, index) => {
    const { notification } = entry;
    if (index > 0) {
      const ruleY = entry.top - ((ENTRY_GAP / 2) | 0) - 1;
      image.drawLine(PANEL_PAD, ruleY, right - 1, ruleY, RULE_VALUE);
    }
    let x = PANEL_PAD;
    const icon = iconFor(notification);
    if (icon) {
      image.drawImage(icon, x, entry.top + ((rowHeight - icon.height) >> 1));
      x += icon.width + ICON_GAP;
    }
    const time = formatTime(notification.postTime);
    const timeWidth = fonts.header.measureText(time);
    const headerY = entry.top + ((rowHeight - fonts.header.lineHeight) >> 1);
    image.drawText(fonts.header, right - timeWidth, headerY, time, HEADER_VALUE);
    image.drawText(fonts.header, x, headerY,
      truncateText(fonts.header, notification.appName, right - timeWidth - ICON_GAP - x), HEADER_VALUE);
    let y = entry.top + rowHeight + LINE_GAP;
    for (const line of entry.titleLines) {
      image.drawText(fonts.title, PANEL_PAD, y, line, TITLE_VALUE);
      y += fonts.title.lineHeight;
    }
    if (entry.titleLines.length && entry.bodyLines.length) y += LINE_GAP;
    for (const line of entry.bodyLines) {
      image.drawText(fonts.body, PANEL_PAD, y, line, BODY_VALUE);
      y += fonts.body.lineHeight;
    }
  });
  if (layout.more.length) {
    image.drawText(fonts.header, PANEL_PAD, layout.moreTop,
      truncateText(fonts.header, moreSummary(layout.more), layout.width - 2 * PANEL_PAD), HEADER_VALUE);
  }
  return image;
}

const BANNER_PAD_X = 12;
const BANNER_PAD_Y = 8;
const BANNER_MIN_WIDTH = 160;
const BANNER_MAX_WIDTH = 400;

/**
 * The asleep banner: the newest notification's app icon and name only (none
 * of its text, which the board shows when opened), plus how many others are
 * waiting, in a rounded box.
 */
export function paintNotificationBanner(
  font: UiFont,
  notifications: readonly GlanceNotification[],
  icon: GrayImage | null,
): GrayImage {
  const newest = notifications[0];
  const name = newest?.appName ?? "Notification";
  const extra = notifications.length > 1 ? `+${notifications.length - 1}` : "";
  const contentHeight = Math.max(icon?.height ?? 0, font.lineHeight);
  const height = contentHeight + 2 * BANNER_PAD_Y;
  const iconWidth = icon ? icon.width + ICON_GAP : 0;
  const extraWidth = extra ? font.measureText(extra) + ICON_GAP * 2 : 0;
  const nameRoom = BANNER_MAX_WIDTH - 2 * BANNER_PAD_X - iconWidth - extraWidth;
  const label = truncateText(font, name, nameRoom);
  const width = Math.max(BANNER_MIN_WIDTH,
    2 * BANNER_PAD_X + iconWidth + font.measureText(label) + extraWidth);
  const image = new GrayImage(width, height, 0);
  image.drawRoundedRect(0, 0, width, height, 140);
  let x = BANNER_PAD_X;
  if (icon) {
    image.drawImage(icon, x, BANNER_PAD_Y + ((contentHeight - icon.height) >> 1));
    x += icon.width + ICON_GAP;
  }
  const textY = BANNER_PAD_Y + ((contentHeight - font.lineHeight) >> 1);
  image.drawText(font, x, textY, label, 230);
  if (extra) image.drawText(font, width - BANNER_PAD_X - font.measureText(extra), textY, extra, 150);
  return image;
}
