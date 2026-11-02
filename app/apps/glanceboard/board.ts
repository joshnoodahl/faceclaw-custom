import { G2_LENS_HEIGHT, GrayImage } from "../../graphics/image";
import { onAnySettingChanged } from "../../ui/dashboard-settings";
import {
  glanceNotificationFonts,
  glanceNotificationIcon,
  glanceNotificationInbox,
  glanceNotificationsEnabled,
} from "./glance-notifications";
import { glanceLayout, glanceShowLinesSetting, glanceSlotSettings } from "./glanceboard-settings";
import { resolveGlanceRegions, slotDividers, type GlanceLayout, type GlanceRegion } from "./layout";
import { layoutNotificationPanel, paintNotificationPanel, type GlanceNotification } from "./notification-panel";
import { type GlanceWidget } from "./widget";
import { findGlanceWidget, glanceWidgetSpans } from "./widgets";

/** Brightness of the hairlines between regions: the dimmest shade that survives 4bpp quantization. */
const DIVIDER_VALUE = 20;

type LiveRegion = { region: GlanceRegion; key: string; widget: GlanceWidget | null };

/** Identity of a region for diffing: which widget, in which slots. */
function regionKey(region: GlanceRegion): string {
  return `${region.choice}@${region.slots.join(",")}`;
}

/**
 * A board: the layout's slots filled with the widgets the settings choose,
 * painted as one image. A widget chosen for two vertically adjacent slots
 * (when it supports that) gets one double-height region with no divider
 * between the slots. Widgets are created and started when the board starts
 * and stopped when it stops; a settings change meanwhile restarts only the
 * regions that changed.
 *
 * The sleep-time board (options.notifications) also carries the unread
 * notifications posted while asleep, in a panel above the slots that grows
 * with the text. When board and panel would not fit on the display, the
 * bottom rows of widgets give way; the first row always stays.
 */
export class GlanceBoard {
  private regions: LiveRegion[] = [];
  private started = false;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeNotifications: (() => void) | null = null;
  private currentLayout: GlanceLayout;
  private readonly fixedLayout?: GlanceLayout;
  private readonly notifications: boolean;
  /** Notifications the last paint showed (whole or cut short): read once the board hides. */
  private shownNotifications: Pick<GlanceNotification, "key" | "postTime">[] = [];

  constructor(
    private readonly requestRender: () => void,
    options: { fixedLayout?: GlanceLayout; notifications?: boolean } = {},
  ) {
    this.fixedLayout = options.fixedLayout;
    this.notifications = options.notifications ?? false;
    this.currentLayout = this.fixedLayout ?? glanceLayout();
  }

  get layout(): GlanceLayout {
    return this.currentLayout;
  }

  get width(): number {
    return this.layout.width;
  }

  get height(): number {
    return this.layout.height;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.applySlotSettings();
    this.unsubscribeSettings = onAnySettingChanged(() => this.applySlotSettings());
    if (this.notifications) {
      this.unsubscribeNotifications = glanceNotificationInbox.onChanged(() => this.requestRender());
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = null;
    // Unsubscribed first: marking these read must not request a paint.
    glanceNotificationInbox.markViewed(this.shownNotifications);
    this.shownNotifications = [];
    for (const live of this.regions) live.widget?.stop();
    this.regions = [];
  }

  private currentRegions(): GlanceRegion[] {
    const choices = glanceSlotSettings(this.layout).map((setting) => setting.get());
    return resolveGlanceRegions(this.layout, choices, glanceWidgetSpans);
  }

  /** Rebuild the live regions from the settings, keeping widgets whose region is unchanged. */
  private applySlotSettings(): void {
    if (!this.started) return;
    const layout = this.fixedLayout ?? glanceLayout();
    const layoutChanged = layout !== this.currentLayout;
    this.currentLayout = layout;
    const previous = new Map(this.regions.map((live) => [live.key, live]));
    const next: LiveRegion[] = [];
    let changed = layoutChanged;
    for (const region of this.currentRegions()) {
      const key = regionKey(region);
      const kept = previous.get(key);
      if (kept) {
        previous.delete(key);
        next.push(kept);
        continue;
      }
      const widget = findGlanceWidget(region.choice)?.create() ?? null;
      widget?.start(this.requestRender);
      next.push({ region, key, widget });
      changed = true;
    }
    for (const removed of previous.values()) {
      removed.widget?.stop();
      changed = true;
    }
    this.regions = next;
    if (changed) this.requestRender();
  }

  /**
   * Paint the whole board: layout-sized, or taller with the notification
   * panel on top. Widgets each get a fresh canvas of their region's size.
   */
  paint(): GrayImage {
    const layout = this.layout;
    const unread = this.notifications && glanceNotificationsEnabled() ? glanceNotificationInbox.unread() : [];
    // The panel may take everything below the first row of widgets.
    const panelMax = G2_LENS_HEIGHT - firstRowBottom(layout) - 1;
    const fonts = unread.length ? glanceNotificationFonts() : null;
    const panel = fonts && panelMax > 0 ? layoutNotificationPanel(fonts, unread, layout.width, panelMax) : null;
    this.shownNotifications = panel ? panel.entries.map(({ notification }) => notification) : [];
    // One hairline row separates the panel from the widgets.
    const top = panel ? panel.height + 1 : 0;
    const gridHeight = panel ? fittingHeight(layout, G2_LENS_HEIGHT - top) : layout.height;
    const image = new GrayImage(layout.width, top + gridHeight, 0);
    if (panel && fonts) {
      paintNotificationPanel(panel, fonts, glanceNotificationIcon).composeInto(image, 0, 0);
      image.drawLine(0, panel.height, layout.width - 1, panel.height, DIVIDER_VALUE);
    }
    // Only whole widgets: one cut off would leave its text hanging below the board.
    const regions = this.regions.filter((live) => live.region.rect.y + live.region.rect.height <= gridHeight);
    for (const live of regions) {
      if (!live.widget) continue;
      const { rect } = live.region;
      const canvas = new GrayImage(rect.width, rect.height, 0);
      try {
        live.widget.paint(canvas);
      } catch (error) {
        console.warn(`glanceboard widget ${live.region.choice} paint failed`, error);
      }
      canvas.composeInto(image, rect.x, top + rect.y);
    }
    if (glanceShowLinesSetting.get()) {
      drawDividers(image, layout, regions.map((live) => live.region), top);
    }
    return image;
  }
}

function drawDividers(image: GrayImage, layout: GlanceLayout, regions: readonly GlanceRegion[], top: number): void {
  for (const line of slotDividers(layout, regions)) {
    image.drawLine(line.x0, top + line.y0, line.x1, top + line.y1, DIVIDER_VALUE);
  }
}

/** Bottom of the layout's first row of slots. */
function firstRowBottom(layout: GlanceLayout): number {
  return Math.min(...layout.slots.map((slot) => slot.rect.y + slot.rect.height));
}

/** The tallest run of whole rows, from the top, that fits in `room`. */
function fittingHeight(layout: GlanceLayout, room: number): number {
  return Math.max(0, ...layout.slots
    .map((slot) => slot.rect.y + slot.rect.height)
    .filter((bottom) => bottom <= room));
}
