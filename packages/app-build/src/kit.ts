// What a Page may import besides its own files: the App Kit and the libraries the kit brings.
// None of it is bundled. An import of one of these names becomes the address of a file the
// instance serves for the kit version the manifest names, so a bundle holds the Page's own code
// only and names no host.

export const APP_KIT_PACKAGE = "@work-shape/catalyst-app-kit";

/**
 * Every kit version this release can build against. A release that ships a kit version adds it
 * here; none is ever removed, because a stored Page names the version it was built with.
 */
export const RELEASED_KIT_VERSIONS: readonly string[] = ["1.0.0", "1.1.0", "1.2.0"];

/** The stylesheet of the shared UI library, with the utility classes its components use. */
export const KIT_STYLESHEET_FILE = "ui.css";
/**
 * The stylesheet of a plain Page: the library's tokens and reset and the base rules for plain
 * elements, without a utility class, so that no class name of an author means anything but
 * what the author's own rule says.
 */
const KIT_PAGE_STYLESHEET_FILE = "page.css";
/**
 * The kit file that gives a document the look of the interface without the rest of the kit: it
 * asks the interface for its theme and mode and keeps the theme tokens on `<html>`.
 */
const KIT_THEME_FILE = "theme.js";
/** The files a kit version has beside those of every version, when it styles plain Pages. */
export const KIT_PLAIN_PAGE_FILES: readonly string[] = [KIT_PAGE_STYLESHEET_FILE, KIT_THEME_FILE];
const KIT_CLIENT_FILE = "kit.js";
/** The first version with a stylesheet for a plain Page and with a theme script. */
const PLAIN_PAGE_STYLES_SINCE = "1.2.0";

/** Where the instance serves the files of a kit version. A path, never a host. */
export const KIT_RUNTIME_PATH = "/app-runtime/kit";

/** The kit file each import name is answered from. */
const KIT_IMPORT_FILES: Readonly<Record<string, string>> = {
  [APP_KIT_PACKAGE]: KIT_CLIENT_FILE,
  [`${APP_KIT_PACKAGE}/ui`]: "ui.js",
  [`${APP_KIT_PACKAGE}/charts`]: "charts.js",
  [`${APP_KIT_PACKAGE}/router`]: "router.js",
  "@tanstack/react-router": "router.js",
  react: "react.js",
  "react/jsx-runtime": "react.js",
  "react-dom": "react.js",
  "react-dom/client": "react.js"
};

/** The names a Page may import that are not its own files. */
export const KIT_IMPORT_NAMES: readonly string[] = Object.keys(KIT_IMPORT_FILES);

/** The address of one file of a kit version. */
export function kitFilePath(kitVersion: string, file: string): string {
  return `${KIT_RUNTIME_PATH}/${kitVersion}/${file}`;
}

/**
 * Whether a kit version gives a plain HTML Page its look. A Page of an earlier version is built
 * as that version built it: a stored Page keeps loading the files of the version it names.
 */
export function kitStylesPlainPages(kitVersion: string): boolean {
  const index = RELEASED_KIT_VERSIONS.indexOf(kitVersion);
  return index !== -1 && index >= RELEASED_KIT_VERSIONS.indexOf(PLAIN_PAGE_STYLES_SINCE);
}

/**
 * The kit files a script imports to mount components of the library: React, the library and the
 * router. The kit's own file calls actions and reads the context, and the charts file draws into
 * an element the script hands it and uses no class, so neither makes a file one of components.
 */
const KIT_COMPONENT_FILES: readonly string[] = ["react.js", "ui.js", "router.js"];

/** Whether an address a built script imports is a kit file that mounts components. */
export function rendersKitComponents(importedPath: string): boolean {
  return KIT_COMPONENT_FILES.some(
    (file) => importedPath.startsWith(`${KIT_RUNTIME_PATH}/`) && importedPath.endsWith(`/${file}`)
  );
}

/**
 * What the build writes first into an HTML file: a stylesheet of the kit and the theme script.
 * A file of plain elements gets the stylesheet of a plain Page. A file whose script renders
 * components of the kit gets the library's stylesheet instead, as the document of a React Page
 * does, and none of the base rules, so that no rule for a plain button reaches a component.
 */
export function htmlPageHead(kitVersion: string, look: "plain" | "components"): string {
  const stylesheet = look === "plain" ? KIT_PAGE_STYLESHEET_FILE : KIT_STYLESHEET_FILE;
  return [
    `<link rel="stylesheet" href="${kitFilePath(kitVersion, stylesheet)}">`,
    `<script type="module" src="${kitFilePath(kitVersion, KIT_THEME_FILE)}"></script>`
  ].join("");
}

/** The address an import name is rewritten to, or nothing when the kit does not provide it. */
export function kitImportPath(kitVersion: string, specifier: string): string | undefined {
  const file = Object.hasOwn(KIT_IMPORT_FILES, specifier) ? KIT_IMPORT_FILES[specifier] : undefined;
  return file === undefined ? undefined : kitFilePath(kitVersion, file);
}
