/**
 * Shows the Glanceboard while the shell sleeps. The board is not a window:
 * it lives on its own full-screen opaque compositor surface above the shell
 * (below only the lock screen), so it never composites with the sidebar,
 * top bar, or the sleeping app's retained frame. The host owns that surface,
 * the visibility state machine (glance-state.ts), its auto-hide timer, and
 * the board's render loop; the controller feeds it sleep-time input and the
 * wake barrier, and takes the compositor back to blank when the board hides.
 * The same surface carries the notification banner (glance-state.ts): a
 * notification posted while asleep shows it in the board's place, and a tap
 * over it swaps in the board.
 */
import { GrayImage, G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../graphics/image";
import { prepareFrameDraws } from "../graphics/glyph-wire";
import { flattenPlanesWithDraws, planesFingerprint, type Plane } from "../graphics/plane";
import * as frameTimings from "../native/frame-timings";
import { type DisplayTarget } from "../native/preview-display";
import { minWindowTop, type ScreenRect } from "../ui/shell/geometry";
import { beginRenderPass, endRenderPass } from "../util/render-freshness";
import { type GlanceBoardInstance, type GlanceboardProvider } from "../apps/app-definition";
import { type AndroidNotification } from "../native/notification-types";
import { GLANCE_HIDDEN, glanceEventForGesture, reduceGlance, type GlanceEvent, type GlanceState } from "./glance-state";

export const GLANCE_SURFACE_ID = "glance";
/** Above the shell (1) and every window (0); below the lock screen (1000). */
export const GLANCE_SURFACE_Z_ORDER = 900;

/** Surface operations needed by the board, shared by Android and iOS. */
export type GlanceDisplay = Pick<DisplayTarget,
  "configureSurface" | "setSurfaceVisible" | "setSurfaceDepth" | "setScreenBlanked" | "submitSurfaceFrame">;

export type GlanceHostOptions = {
  getDisplay: () => GlanceDisplay | null;
  getProvider: () => GlanceboardProvider | null;
  /** Whether a board may show right now (connected or preview, not locked). */
  canShow: () => boolean;
  /**
   * The controller's wake barrier: restore the EvenHub session if it was
   * suspended and unblank the compositor. Resolves once the frame is visible.
   */
  ensureSessionActive: (frameId: number) => Promise<boolean>;
  /**
   * The board hid on its own (timer or release) with the shell still
   * asleep: the controller re-blanks and re-arms the screen-off power save.
   */
  onHiddenWhileAsleep: () => void;
  /** Visibility changed either way (phone mirror refresh). */
  onVisibilityChanged: () => void;
  appendLog: (message: string) => void;
};

export class GlanceHost {
  private state: GlanceState = GLANCE_HIDDEN;
  private board: GlanceBoardInstance | null = null;
  /** Whether the surface is currently visible on the compositor. */
  private shown = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private configuredFor: GlanceDisplay | null = null;
  /** Last depth given to the surface; null forces the next render to set it. */
  private configuredDepth: number | null = null;
  /** Serializes show/hide against each other and against in-flight renders. */
  private queue: Promise<void> = Promise.resolve();
  private rendering = false;
  private renderPending = false;
  private nextRenderWantsFreshData = false;
  /** Where the last render put the board on screen. */
  private boardRect: ScreenRect | null = null;

  constructor(private readonly options: GlanceHostOptions) {}

  isVisible(): boolean {
    return this.state.visible;
  }

  /** The board's area of the screen while it shows (for the phone mirror's Scaled preview), else null. */
  screenRect(): ScreenRect | null {
    return this.state.visible ? this.boardRect : null;
  }

  /** Whether sleep-time gestures should reach the board at all. */
  isEnabled(): boolean {
    return this.options.getProvider()?.isEnabled() ?? false;
  }

  /**
   * Whether a notification posted now, while asleep, belongs to the board
   * (banner, then the board) rather than the regular popup.
   */
  takesNotifications(): boolean {
    const provider = this.options.getProvider();
    return !!provider?.isEnabled() && provider.notifications.enabled() && this.options.canShow();
  }

  /** Hand a notification posted while asleep to the board and show its banner. */
  async notificationPosted(notification: AndroidNotification): Promise<void> {
    const provider = this.options.getProvider();
    if (!provider) return;
    provider.notifications.posted(notification);
    await this.handleEvent({ type: "banner" }, frameTimings.startFrame("glanceboard notification"));
  }

  /** The phone withdrew a notification: the board forgets it (a showing board repaints itself). */
  notificationRemoved(notificationKey: string): void {
    this.options.getProvider()?.notifications.removed(notificationKey);
    if (this.state.visible && this.state.banner) this.requestRender();
  }

  /**
   * The glance event a sleep-time gesture means under the board's settings,
   * or null when the shell should see the input as usual: nothing while the
   * board is disabled, no press from a tap when "Show on tap" is disabled,
   * no hold when "Show on long press" is off, no press from a head-tilt when
   * "Show on head tilt" is off (it then wakes the regular UI). A release
   * always passes so a hold in progress can end.
   */
  eventForGesture(gesture: "head-tilt" | (string & {})): GlanceEvent | null {
    const provider = this.options.getProvider();
    if (!provider?.isEnabled()) return null;
    if (gesture === "click" && !provider.showOnTap()) return null;
    if ((gesture === "long-press" || gesture === "short-then-long-press") && !provider.showOnLongPress()) return null;
    if (gesture === "head-tilt" && !provider.showOnHeadTilt()) return null;
    return glanceEventForGesture(gesture, this.isVisible());
  }

  /**
   * Apply a glance event from sleep-time input. The frame is owned from here:
   * a show submits it with the board's first frame, anything else finishes it.
   */
  async handleEvent(event: GlanceEvent, frameId: number): Promise<void> {
    const before = this.state;
    const timeoutMs = this.options.getProvider()?.tapTimeoutMs();
    this.state = reduceGlance(before, event, Date.now(), timeoutMs);
    this.armHideTimer();
    if (this.state.visible === before.visible) {
      // Same surface, new content: the banner gave way to the board, or a
      // newer notification replaced the banner's.
      const contentChanged = before.banner !== this.state.banner || (this.state.banner && event.type === "banner");
      if (this.state.visible && contentChanged) {
        await this.enqueue(() => this.render(frameId));
        return;
      }
      frameTimings.finishFrame(frameId, this.state.visible ? "glanceboard stays up" : "glance event while hidden");
      return;
    }
    if (this.state.visible) {
      await this.enqueue(() => this.show(frameId));
    } else {
      frameTimings.finishFrame(frameId, "glanceboard hidden");
      await this.enqueue(() => this.hide(true));
    }
  }

  /**
   * Hide because the regular UI is waking (double-tap, a notification, ...):
   * the shell's own wake path handles the compositor from here, so no re-blank.
   */
  dismiss(): void {
    if (!this.state.visible && !this.shown && !this.board) return;
    this.state = GLANCE_HIDDEN;
    this.armHideTimer();
    void this.enqueue(() => this.hide(false));
  }

  /** The display target went away (disconnect, preview teardown): forget everything. */
  reset(): void {
    this.state = GLANCE_HIDDEN;
    this.armHideTimer();
    this.board?.stop();
    this.board = null;
    this.shown = false;
    this.configuredFor = null;
    this.renderPending = false;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(operation, operation).catch((error) => {
      this.options.appendLog(`glanceboard operation failed: ${String(error)}`);
    });
    this.queue = run;
    return run;
  }

  private armHideTimer(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    const hideAtMs = this.state.hideAtMs;
    if (!this.state.visible || hideAtMs === null) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      void this.handleEvent({ type: "timeout" }, frameTimings.startFrame("glanceboard timeout"));
    }, Math.max(0, hideAtMs - Date.now()));
  }

  private async configureSurface(display: GlanceDisplay): Promise<void> {
    await display.configureSurface(GLANCE_SURFACE_ID, {
      x: 0,
      y: 0,
      width: G2_LENS_WIDTH,
      height: G2_LENS_HEIGHT,
      zOrder: GLANCE_SURFACE_Z_ORDER,
      transparency: "opaque",
    });
    await display.setSurfaceVisible(GLANCE_SURFACE_ID, false);
    this.configuredDepth = null;
    this.configuredFor = display;
  }

  private async show(frameId: number): Promise<void> {
    if (!this.state.visible) {
      // Hidden again before this ran (a quick release); nothing to do.
      frameTimings.finishFrame(frameId, "glanceboard show superseded");
      return;
    }
    const display = this.options.getDisplay();
    const provider = this.options.getProvider();
    if (!display || !provider || !this.options.canShow()) {
      this.state = GLANCE_HIDDEN;
      this.armHideTimer();
      frameTimings.finishFrame(frameId, "glanceboard unavailable");
      return;
    }
    if (this.configuredFor !== display) await this.configureSurface(display);
    // Submit the first frame and reveal the surface while the compositor is
    // still blanked, so the unblank below composites the board on top of the
    // sleeping UI in one step rather than flashing the app first.
    await this.render(frameId);
    await display.setSurfaceVisible(GLANCE_SURFACE_ID, true);
    this.shown = true;
    const ready = await this.options.ensureSessionActive(frameId);
    if (!ready) this.options.appendLog("glanceboard: wake barrier did not complete");
    this.options.onVisibilityChanged();
  }

  private async hide(stillAsleep: boolean): Promise<void> {
    const wasShown = this.shown;
    this.shown = false;
    const display = this.options.getDisplay();
    if (wasShown && display && this.configuredFor === display) {
      // Blank before revealing what is under the board: hiding the surface
      // first recomposites the sleeping UI's retained frames and transmits
      // them, a visible flash of the main UI before the screen goes dark.
      // Blanked, the surface change composites to the same black frame. (The
      // controller's screen-off path below blanks again, harmlessly.)
      if (stillAsleep) {
        await display.setScreenBlanked(true);
      }
      await display.setSurfaceVisible(GLANCE_SURFACE_ID, false);
    }
    this.board?.stop();
    this.board = null;
    this.renderPending = false;
    if (wasShown && stillAsleep) this.options.onHiddenWhileAsleep();
    if (wasShown) this.options.onVisibilityChanged();
  }

  private requestRender(): void {
    if (!this.board && !this.state.banner) return;
    if (this.rendering) {
      this.renderPending = true;
      return;
    }
    void this.enqueue(() => this.render(frameTimings.startFrame("render:glanceboard")));
  }

  /**
   * Paint the board (or the banner) into a full-screen frame and submit it to
   * the surface. The board starts on its first paint, so a banner that is
   * never opened never starts the widgets.
   */
  private async render(frameId: number): Promise<void> {
    const display = this.options.getDisplay();
    const provider = this.options.getProvider();
    if (!this.state.visible || !provider || !display || this.configuredFor !== display) {
      frameTimings.finishFrame(frameId, "discarded: glanceboard not showing");
      return;
    }
    if (!this.state.banner && !this.board) {
      this.board = provider.createBoard(() => this.requestRender());
      this.board.start();
    }
    const board = this.state.banner ? null : this.board;
    const content = board ? () => board.paint() : () => provider.notifications.paintBanner();
    this.rendering = true;
    try {
      frameTimings.annotateFrame(frameId, board ? "glanceboard" : "glanceboard banner");
      const wantFreshData = this.nextRenderWantsFreshData;
      this.nextRenderWantsFreshData = false;
      beginRenderPass(!wantFreshData);
      const paintStartedAtMs = Date.now();
      const frame = frameTimings.span(frameId, "paint", () =>
        frameTimings.runWithFrame(frameId, () => {
          const boardImage = content();
          const full = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
          // Centred horizontally in the panel, in the standard window band
          // vertically (Display > Vertical position).
          const x = Math.max(0, ((G2_LENS_WIDTH - boardImage.width) / 2) | 0);
          const y = Math.max(0, Math.min(G2_LENS_HEIGHT - boardImage.height, minWindowTop()));
          boardImage.composeInto(full, x, y);
          this.boardRect = { x, y, width: boardImage.width, height: boardImage.height };
          return full;
        }),
      );
      const paintUsedStaleData = endRenderPass();
      const paintMs = Date.now() - paintStartedAtMs;
      const planes: Plane[] = [{ image: frame, x: 0, y: 0 }];
      const fingerprint = frameTimings.span(frameId, "fingerprint", () => planesFingerprint(planes));
      const { image, draws } = frameTimings.span(frameId, "flatten", () => flattenPlanesWithDraws(planes));
      const buffer = frameTimings.span(frameId, "to8bpp", () => image.to8bppBuffer());
      const preparedDraws = frameTimings.span(frameId, "prepareFrameDraws", () => prepareFrameDraws(draws));
      // The glasses copy the screen shifted per lens while the board covers it.
      const depth = this.options.getProvider()?.depth() ?? 0;
      if (depth !== this.configuredDepth) {
        await display.setSurfaceDepth(GLANCE_SURFACE_ID, depth);
        this.configuredDepth = depth;
      }
      await frameTimings.spanAsync(frameId, "submit", () =>
        display.submitSurfaceFrame(
          GLANCE_SURFACE_ID,
          buffer,
          { x: 0, y: 0, width: image.width, height: image.height },
          fingerprint,
          paintMs,
          frameId,
          preparedDraws,
        ),
      );
      if (paintUsedStaleData) {
        // Same contract as the windows: a paint that used cached data (the
        // notification icons) gets one follow-up with fresh data.
        this.nextRenderWantsFreshData = true;
        this.renderPending = true;
      }
    } finally {
      this.rendering = false;
      if (this.renderPending && (this.board || this.state.banner)) {
        this.renderPending = false;
        this.requestRender();
      }
    }
  }
}
