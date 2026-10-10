// What a Page may import besides its own files: the App Kit and the libraries the kit brings.
// None of it is bundled. An import of one of these names becomes the address of a file the
// instance serves for the kit version the manifest names, so a bundle holds the Page's own code
// only and names no host.

export const APP_KIT_PACKAGE = "@work-shape/catalyst-app-kit";

/**
 * Every kit version this release can build against. A release that ships a kit version adds it
 * here; none is ever removed, because a stored Page names the version it was built with.
 */
export const RELEASED_KIT_VERSIONS: readonly string[] = ["1.0.0"];

/** Where the instance serves the files of a kit version. A path, never a host. */
export const KIT_RUNTIME_PATH = "/app-runtime/kit";

/** The kit file each import name is answered from. */
const KIT_IMPORT_FILES: Readonly<Record<string, string>> = {
  [APP_KIT_PACKAGE]: "kit.js",
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

/** The address an import name is rewritten to, or nothing when the kit does not provide it. */
export function kitImportPath(kitVersion: string, specifier: string): string | undefined {
  const file = Object.hasOwn(KIT_IMPORT_FILES, specifier) ? KIT_IMPORT_FILES[specifier] : undefined;
  return file === undefined ? undefined : kitFilePath(kitVersion, file);
}
