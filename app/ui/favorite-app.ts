import { getDefaultSmallFont } from "../graphics/ui-fonts";
import { ConfigSettingString } from "./dashboard-settings";
import { drawRightValueMenuItem, openModalMenu, type MenuItem } from "./menu";
import { LIST_ROW_TEXT_INSET } from "./metrics";

/** The app a ring triple tap opens (see triple-tap.ts); empty for none. */
export const favoriteAppSetting = new ConfigSettingString({
  id: "ring-triple-tap-app",
  label: "Triple-tap app",
  storageKey: "ring.tripleTapApp",
  defaultValue: "",
  description:
    "The app a triple tap on the ring opens (or brings to the front), waking the display if needed. The first two taps still act as a double tap. None turns triple tap off.",
});

export type FavoriteAppChoice = { appId: string; title: string };

let catalog: () => FavoriteAppChoice[] = () => [];

/**
 * The apps the picker offers. The dashboard controller supplies them (it
 * owns the app list, including installed EvenHub apps), so this module stays
 * free of the apps it names.
 */
export function setFavoriteAppCatalog(provider: () => FavoriteAppChoice[]): void {
  catalog = provider;
}

function favoriteAppTitle(appId: string): string {
  if (!appId) return "None";
  return catalog().find((choice) => choice.appId === appId)?.title ?? appId;
}

/** Settings row: the current app at the right; opens a picker of every app, plus None. */
export function favoriteAppMenuItem(): MenuItem {
  const label = favoriteAppSetting.label;
  return {
    label,
    description: favoriteAppSetting.description,
    onSelect: (ctx) => {
      const choices = [{ appId: "", title: "None" }, ...catalog()
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))];
      const current = favoriteAppSetting.get();
      const items = choices.map((choice): MenuItem => ({
        label: choice.title,
        onSelect: (menuCtx) => {
          favoriteAppSetting.set(choice.appId);
          menuCtx.stack.pop();
        },
        render: ({ image, x, y }) => {
          const selected = favoriteAppSetting.get() === choice.appId ? " *" : "";
          image.drawText(getDefaultSmallFont(), x, y + LIST_ROW_TEXT_INSET, `${choice.title}${selected}`, 200);
        },
      }));
      openModalMenu(ctx, label, items, Math.max(0, choices.findIndex((choice) => choice.appId === current)));
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, label, favoriteAppTitle(favoriteAppSetting.get()));
    },
  };
}
