import { useSyncExternalStore } from "react";
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

/**
 * A kind's own New dialog asked for from outside Studio, such as from a draft's card in a
 * conversation: the list of the kind opens it, whether it is shown already or opens now.
 */
let dialogRequested: string | undefined;
const dialogListeners = new Set<() => void>();

function subscribeDialog(listener: () => void): () => void {
  dialogListeners.add(listener);
  return () => dialogListeners.delete(listener);
}

function dialogRequestedNow(): string | undefined {
  return dialogRequested;
}

/** Asks the list of a kind to open its New dialog. */
export function requestBuildCreateDialog(kindPath: string): void {
  dialogRequested = kindPath;
  for (const listener of dialogListeners) listener();
}

/** A hook: whether the list of this kind was asked to open its New dialog. */
export function useBuildCreateDialogRequest(kindPath: string | undefined): boolean {
  const now = useSyncExternalStore(subscribeDialog, dialogRequestedNow, dialogRequestedNow);
  return kindPath !== undefined && now === kindPath;
}

/** Forgets the request: the list opened the dialog. */
export function clearBuildCreateDialogRequest(): void {
  dialogRequested = undefined;
  for (const listener of dialogListeners) listener();
}
