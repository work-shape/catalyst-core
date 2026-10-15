// The address of a Page in its frame, over time. The address holds a token that is valid for
// an hour and names one mount of the frame, so a renewed address is another document: the
// frame cannot move to it without loading the Page again.
//
// So the surface does two things at two moments. It asks for the next address while the
// current one is still valid, which also tells it early that the viewer lost the Page. And it
// moves the frame at the moment the current address stops serving, not before: from then on
// every file the Page still asks for would be refused. The Page starts again on the route it
// was on; what it held in memory is gone.
//
// Time is measured on this device alone. The instance says when the token expires by its own
// clock, and a device clock may be an hour off, so the surface never compares the two. It
// counts the known lifetime of a token from the moment it asked for the address, which is
// never later than the moment the instance made the token.

import { ApiError } from "@work-shape/catalyst-api-client";

/**
 * How long a token serves, as the instance mints it (`APP_CONTENT_TOKEN_TTL_SECONDS` of the
 * chat server). A longer lifetime there only makes the surface renew early; a shorter one
 * needs this number changed with it.
 */
export const PAGE_ADDRESS_LIFETIME_MS = 60 * 60_000;

/** How long before its address expires a mounted preview asks for the next one. */
export const PAGE_ADDRESS_RENEWAL_MARGIN_MS = 5 * 60_000;

/** The wait after the first asking that failed. Each further failure doubles it. */
export const PAGE_ADDRESS_RETRY_MS = 30_000;

/** The longest wait between two askings that failed. */
export const PAGE_ADDRESS_RETRY_MAX_MS = 5 * 60_000;

/** What the surface reads of an address: where it is. */
export interface PageAddress {
  url: string;
}

/** An address with the moment, on this device's clock, until which it serves. */
export interface HeldPageAddress<Address extends PageAddress> {
  address: Address;
  servesUntil: number;
}

/** An address the instance gave to an asking that was sent at `askedAt`. */
export function heldPageAddress<Address extends PageAddress>(
  address: Address,
  askedAt: number
): HeldPageAddress<Address> {
  return { address, servesUntil: askedAt + PAGE_ADDRESS_LIFETIME_MS };
}

/**
 * The address the frame holds. It keeps the one it has while that one serves. When it has
 * none or its own has expired it takes the newest one, unless that one has expired too: an
 * address that no longer serves is never put into the frame.
 */
export function pageAddressToShow<Address extends PageAddress>(
  shown: HeldPageAddress<Address> | undefined,
  newest: HeldPageAddress<Address> | undefined,
  now: number
): HeldPageAddress<Address> | undefined {
  if (shown && now < shown.servesUntil) {
    return shown;
  }
  return newest && now < newest.servesUntil ? newest : shown;
}

/**
 * How long to wait after an asking failed, for the `attempt`-th failure in a row counted from
 * zero. An instance that says how long to wait is obeyed. Otherwise the wait doubles up to
 * the ceiling, and each wait is shortened by up to half at random so that many open previews
 * do not ask at the same moment.
 */
export function pageAddressRetryDelay(attempt: number, error: unknown, random: number): number {
  if (error instanceof ApiError && error.status === 429 && error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds * 1000;
  }
  const step = Math.min(PAGE_ADDRESS_RETRY_MAX_MS, PAGE_ADDRESS_RETRY_MS * 2 ** attempt);
  return Math.round(step * (1 - random / 2));
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

/** What the keeper takes from its surroundings; the tests give their own. */
export interface PageAddressSurroundings {
  /** Calls the listener each time the tab becomes visible; returns how to end that. */
  onVisible: (listener: () => void) => () => void;
  /** A number from 0 up to 1 for the spread of the waits. */
  random: () => number;
}

const browserSurroundings: PageAddressSurroundings = {
  onVisible: (listener) => {
    if (typeof document === "undefined") {
      return () => undefined;
    }
    const heard = () => {
      if (document.visibilityState === "visible") {
        listener();
      }
    };
    document.addEventListener("visibilitychange", heard);
    return () => document.removeEventListener("visibilitychange", heard);
  },
  random: Math.random
};

/**
 * Keeps the address of a mounted preview. It asks for the address, asks for the next one the
 * margin before the token expires, and moves the frame to the newest address when the one it
 * holds stops serving. The address is a credential for the frame and is kept nowhere else.
 *
 * One asking is on its way at a time: whoever asks meanwhile waits for that answer. An answer
 * that the Page is gone ends the asking for good. Any other failure is asked again after a
 * growing wait. After `stop` nothing is asked and nothing is told.
 */
export function keepPageAddress<Address extends PageAddress>(
  ask: () => Promise<Address>,
  onChange: (state: PageAddressState<Address>) => void,
  surroundings: PageAddressSurroundings = browserSurroundings
): { again: () => void; stop: () => void } {
  let shown: HeldPageAddress<Address> | undefined;
  let newest: HeldPageAddress<Address> | undefined;
  let gone = false;
  let failed = false;
  let stopped = false;
  let asking = false;
  let failures = 0;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let move: ReturnType<typeof setTimeout> | undefined;

  const ended = () => stopped || gone;
  const tell = () => onChange({ shown: shown?.address, gone, failed });

  /** Puts the right address into the frame and comes back when that one stops serving. */
  const settle = () => {
    clearTimeout(move);
    if (ended()) {
      return;
    }
    const now = Date.now();
    const next = pageAddressToShow(shown, newest, now);
    if (next !== shown) {
      shown = next;
      tell();
    }
    if (shown && now < shown.servesUntil) {
      move = setTimeout(settle, shown.servesUntil - now);
    } else if (shown) {
      // The frame's address has expired and so has what was held for it, as after a sleep.
      request();
    }
  };

  const request = () => {
    if (ended() || asking) {
      return;
    }
    asking = true;
    clearTimeout(renewal);
    const askedAt = Date.now();
    ask().then(
      (address) => {
        asking = false;
        if (ended()) {
          return;
        }
        newest = heldPageAddress(address, askedAt);
        failures = 0;
        if (failed) {
          failed = false;
          tell();
        }
        settle();
        renewal = setTimeout(
          request,
          Math.max(0, newest.servesUntil - PAGE_ADDRESS_RENEWAL_MARGIN_MS - Date.now())
        );
      },
      (error: unknown) => {
        asking = false;
        if (ended()) {
          return;
        }
        if (pageIsGone(error)) {
          gone = true;
          clearTimeout(move);
          tell();
          return;
        }
        if (!failed) {
          failed = true;
          tell();
        }
        renewal = setTimeout(
          request,
          pageAddressRetryDelay(failures, error, surroundings.random())
        );
        failures += 1;
      }
    );
  };

  const unsubscribe = surroundings.onVisible(() => {
    // Timers stand still while a device sleeps. Back in view, an address past its renewal
    // point is asked for at once instead of when the late timer fires.
    if (newest && Date.now() >= newest.servesUntil - PAGE_ADDRESS_RENEWAL_MARGIN_MS) {
      request();
    }
  });
  request();

  return {
    again: request,
    stop: () => {
      stopped = true;
      clearTimeout(renewal);
      clearTimeout(move);
      unsubscribe();
    }
  };
}
