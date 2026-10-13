/**
 * A wish to start a new asset that was made outside Build, such as on the Agents page. A new
 * asset has no address, so the wish cannot travel in one: it is kept here for the one step
 * from that page to the kind's list, which opens its dialog and forgets the wish.
 */
let requestedKindPath: string | undefined;

/** Asks the list of a kind to open the dialog that starts an asset, once it is shown. */
export function requestBuildCreate(kindPath: string): void {
  requestedKindPath = kindPath;
}

/** A list of this kind was asked to open its dialog. Reading it changes nothing. */
export function buildCreateRequested(kindPath: string | undefined): boolean {
  return kindPath !== undefined && requestedKindPath === kindPath;
}

/** Forgets the wish: Build has been reached, whatever it showed. */
export function clearBuildCreateRequest(): void {
  requestedKindPath = undefined;
}
