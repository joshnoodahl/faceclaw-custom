import { type GrayImage } from "../../graphics/image";
import { readNotificationIconByKey } from "../../native/notification-icons";
import { type AndroidNotification } from "../../native/notification-types";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../../util/render-freshness";
import { glanceFont } from "./glance-font";
import { glanceboardEnabledSetting, glanceNotificationsSetting } from "./glanceboard-settings";
import {
  glanceNotificationFrom,
  GlanceNotificationInbox,
  paintNotificationBanner,
  type DrawFonts,
  type GlanceNotification,
} from "./notification-panel";

/** Unread notifications posted while asleep, shared by the banner and the board. */
export const glanceNotificationInbox = new GlanceNotificationInbox();

/** Whether notifications posted while asleep go to the board instead of the popup. */
export function glanceNotificationsEnabled(): boolean {
  return glanceboardEnabledSetting.get() && glanceNotificationsSetting.get();
}

export function glanceNotificationPosted(notification: AndroidNotification): void {
  glanceNotificationInbox.add(glanceNotificationFrom(notification));
}

export function glanceNotificationRemoved(notificationKey: string): void {
  glanceNotificationInbox.remove(notificationKey);
}

export function glanceNotificationFonts(): DrawFonts {
  return { header: glanceFont.small(), title: glanceFont.medium(), body: glanceFont.small() };
}

/** The app icon, with the same stale-data contract as the system card's icons. */
export function glanceNotificationIcon(notification: GlanceNotification): GrayImage | null {
  const { icon, stale } = readNotificationIconByKey(notification.key, renderPassAllowsStaleData());
  if (stale) noteStaleDataUsed();
  return icon;
}

export function paintGlanceNotificationBanner(): GrayImage {
  const unread = glanceNotificationInbox.unread();
  const newest = unread[0];
  return paintNotificationBanner(glanceFont.medium(), unread, newest ? glanceNotificationIcon(newest) : null);
}
