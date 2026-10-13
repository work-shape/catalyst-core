import type { BuildAssetStart } from "./build-asset-kind";

/**
 * A new asset started outside Studio, such as from the Agents page: its dialog was answered
 * there, and the kind's list opens the new asset's page with that name and id. A new asset has
 * no address, so the start cannot travel in one: it is kept here for the one step to the list,
 * which takes it and forgets it.
 */
let requested: { kindPath: string; start: BuildAssetStart } | undefined;

/** Asks the list of a kind to open the page of this new asset, once it is shown. */
export function requestBuildStart(kindPath: string, start: BuildAssetStart): void {
  requested = { kindPath, start };
}

/** The new asset a list of this kind was asked to open. Reading it changes nothing. */
export function requestedBuildStart(kindPath: string | undefined): BuildAssetStart | undefined {
  return kindPath !== undefined && requested?.kindPath === kindPath ? requested.start : undefined;
}

/** Forgets the start: Studio has been reached, whatever it showed. */
export function clearBuildStartRequest(): void {
  requested = undefined;
}
