// The colour values of ServiceMark, kept with the theme: the ink of an initial, and the
// gallery's samples. A service's own colour comes from its catalogue entry, never from here.

/** The ink of the letter on a coloured tile. An entry's colour is only taken when it holds it. */
export const SERVICE_MARK_INK = "#ffffff";

/** The gallery's sample colours: of no vendor, each holding the white initial. */
export const SERVICE_MARK_SAMPLE_COLORS = { ledger: "#1f5f99", files: "#6b3fa0" } as const;

/**
 * The gallery's sample logo: a neutral drawing of no vendor, a grey disc with a white cross, to
 * show how a supplied logo stands. A PNG, as an entry's logo may be.
 */
export const SERVICE_MARK_SAMPLE_LOGO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAVElEQVR42mNgGBGgqm3Wf2yYZgZTbBGxBpNlET4DYIAiS2hqAaEgIMYCvJbQ1AJiIpFYC7BaQlcLyAWDx4KhGQdDPx8Mj7KILsU1XSoculWZQwIAAFaQfSYadwTlAAAAAElFTkSuQmCC";
