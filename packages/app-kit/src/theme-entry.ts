// `theme.js` of a kit version: the look of the interface for an HTML file. The build loads it in
// every HTML file of a plain HTML Page. It asks the interface for its theme and mode, as a React
// Page's root does, and keeps the tokens on `<html>`, where the rules of the kit's stylesheet
// and the author's own rules read them. It brings neither React nor the library's components,
// and it greets the interface for itself: a Page whose script imports the kit greets a second
// time and is told the same.
import { createThemeTokens } from "@vivd-catalyst/ui/theme";
import { getContext, onThemeChange } from "./client";
import type { AppThemeChange } from "./protocol";

/** Puts a look on the document the way `UiRoot` puts it on its element. */
function applyLook({ theme, mode }: AppThemeChange): void {
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  for (const [token, value] of Object.entries(createThemeTokens(theme, mode))) {
    root.style.setProperty(token, value);
  }
}

onThemeChange(applyLook);
// Outside the interface nothing answers, and the stylesheet's default theme stays.
void getContext().then(applyLook, () => undefined);
