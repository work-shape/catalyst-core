// The colour values of ServiceMark, kept with the theme: the ink of an initial, and the
// gallery's samples. A service's own colour comes from its catalogue entry, never from here.

/** The ink of the letter on a coloured tile. An entry's colour is only taken when it holds it. */
export const SERVICE_MARK_INK = "#ffffff";

/** The gallery's sample colours: of no vendor, each holding the white initial. */
export const SERVICE_MARK_SAMPLE_COLORS = { ledger: "#1f5f99", files: "#6b3fa0" } as const;

/** The gallery's sample logo: a neutral drawing of no vendor, to show how a supplied logo stands. */
export const SERVICE_MARK_SAMPLE_LOGO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#7a869a"/><path d="M7 12h10M12 7v10" stroke="#ffffff" stroke-width="2"/></svg>'
)}`;
