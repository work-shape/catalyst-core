// The address of a Page in its frame, over time. The address holds a token that is valid for
// an hour and names one mount of the frame, so a renewed address is another document: the
// frame cannot move to it without loading the Page again.
//
// So the surface does two things at two moments. It asks for the next address while the
// current one is still valid, which also tells it early that the viewer lost the Page. And it
// moves the frame at the moment the current address stops serving, not before: from then on
// every file the Page still asks for would be refused. The Page starts again on the route it
// was on; what it held in memory is gone.

import { ApiError } from "@vivd-catalyst/api-client";

/** How long before its address expires a mounted preview asks for the next one. */
export const PAGE_ADDRESS_RENEWAL_MARGIN_MS = 5 * 60_000;

/**
 * The shortest wait before asking again. An address that is already inside the margin, by a
 * short lifetime or a clock that runs ahead, is not asked for in a loop.
 */
export const PAGE_ADDRESS_RENEWAL_MIN_WAIT_MS = 30_000;

/** What the surface reads of an address: where it is and until when it serves. */
export interface PageAddress {
  url: string;
  expiresAt: string;
}

/** How long from `now` until the next address is asked for. */
export function pageAddressRenewalDelay(address: PageAddress, now: number): number {
  return Math.max(
    PAGE_ADDRESS_RENEWAL_MIN_WAIT_MS,
    Date.parse(address.expiresAt) - PAGE_ADDRESS_RENEWAL_MARGIN_MS - now
  );
}

/** How long from `now` the address still serves. */
export function pageAddressRemaining(address: PageAddress, now: number): number {
  return Math.max(0, Date.parse(address.expiresAt) - now);
}

/**
 * The address the frame holds. It keeps the one it has while that one serves, and takes the
 * newest one when it has none or when its own has expired.
 */
export function pageAddressToShow<Address extends PageAddress>(
  shown: Address | undefined,
  newest: Address | undefined,
  now: number
): Address | undefined {
  if (!newest || newest.url === shown?.url) {
    return shown;
  }
  if (!shown) {
    return newest;
  }
  return pageAddressRemaining(shown, now) === 0 ? newest : shown;
}

/** Whether the instance answered that the Page is not there for the viewer. */
export function pageIsGone(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 403);
}

/** An answer that says the Page is not there does not change by asking again. */
export function retryUnlessGone(failureCount: number, error: unknown): boolean {
  return !pageIsGone(error) && failureCount < 2;
}

/** What a mounted preview knows of its address. */
export interface PageAddressState<Address extends PageAddress> {
  /** The address the frame holds. */
  shown?: Address;
  /** The instance answered that the Page is not there for the viewer. */
  gone: boolean;
  /** The last asking failed for another reason; it is asked again by itself. */
  failed: boolean;
}

/**
 * Keeps the address of a mounted preview. It asks for the address, asks for the next one the
 * margin before the token expires, and moves the frame to the newest address when the one it
 * holds stops serving. The address is a credential for the frame and is kept nowhere else.
 * An answer that the Page is gone ends the asking; any other failure is asked again soon.
 */
export function keepPageAddress<Address extends PageAddress>(
  ask: () => Promise<Address>,
  onChange: (state: PageAddressState<Address>) => void
): { again: () => void; stop: () => void } {
  let shown: Address | undefined;
  let newest: Address | undefined;
  let gone = false;
  let failed = false;
  let stopped = false;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let move: ReturnType<typeof setTimeout> | undefined;

  const tell = () => onChange({ shown, gone, failed });
  const settle = () => {
    clearTimeout(move);
    const next = pageAddressToShow(shown, newest, Date.now());
    if (next !== shown) {
      shown = next;
      tell();
    }
    if (shown && newest !== shown) {
      move = setTimeout(settle, pageAddressRemaining(shown, Date.now()));
    }
  };
  const request = () => {
    clearTimeout(renewal);
    ask().then(
      (address) => {
        if (stopped) {
          return;
        }
        newest = address;
        if (failed) {
          failed = false;
          tell();
        }
        settle();
        renewal = setTimeout(request, pageAddressRenewalDelay(address, Date.now()));
      },
      (error: unknown) => {
        if (stopped) {
          return;
        }
        if (pageIsGone(error)) {
          gone = true;
          clearTimeout(move);
          tell();
          return;
        }
        failed = true;
        tell();
        renewal = setTimeout(request, PAGE_ADDRESS_RENEWAL_MIN_WAIT_MS);
      }
    );
  };
  request();

  return {
    again: () => {
      if (!stopped && !gone) {
        request();
      }
    },
    stop: () => {
      stopped = true;
      clearTimeout(renewal);
      clearTimeout(move);
    }
  };
}
