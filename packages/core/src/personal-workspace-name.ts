/** The name and possessive form used when naming a Personal Workspace after its owner. */
export function personalWorkspaceOwnerName(
  ownerLabel: string | undefined
): { name: string; sibilant: boolean } | undefined {
  const label = ownerLabel?.trim() ?? "";
  if (label === "" || label.includes("@")) return undefined;
  const name = label.split(/\s+/u)[0];
  if (name === undefined) return undefined;
  // German uses only an apostrophe after a name ending in an s sound: "Felix'".
  return { name, sibilant: /[sßxz]$/iu.test(name) };
}
