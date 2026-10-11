import { ArrowUpRight } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

const DocsAddressContext = createContext<string | undefined>(undefined);

export interface DocsAddressProviderProps {
  /** Where the instance's documentation is read. Without it no `DocsLink` below renders. */
  address: string | undefined;
  children: ReactNode;
}

/** Tells every `DocsLink` below where the documentation is read. */
export function DocsAddressProvider({ address, children }: DocsAddressProviderProps) {
  return <DocsAddressContext value={address}>{children}</DocsAddressContext>;
}

/**
 * The address of one page of the documentation: the path joined to the documentation's own
 * address, whatever path that one already has. Nothing without a documentation address.
 */
export function docsAddress(address: string | undefined, path: string): string | undefined {
  if (!address) {
    return undefined;
  }
  return `${address.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/**
 * Whether a `DocsLink` here renders. For a slot that would stay behind empty, such as a
 * field's hint: leave the slot out instead of filling it with a link that shows nothing.
 */
export function useDocsLinkShown(): boolean {
  return Boolean(useContext(DocsAddressContext));
}

export interface DocsLinkProps {
  /** The page inside the documentation, with its anchor: `/operate/how-rights-work/#grants`. */
  path: string;
  /**
   * What the link is read as: its label, its topic and that it opens a new tab, such as
   * "Learn more about Namespaces, opens in a new tab".
   */
  accessibleName: string;
  /** The label: "Learn more" after a sentence, a name of its own where the link stands alone. */
  children: ReactNode;
}

/**
 * A link from a page into the documentation, in the text it stands in: the colour of that
 * text, underlined, with the mark of a way out, opening a new tab. It renders nothing on an
 * instance without a documentation address, so the sentence before it has to be complete
 * without it. One per page head and one per section of a dialog, never on a repeated element.
 */
export function DocsLink({ path, accessibleName, children }: DocsLinkProps) {
  const href = docsAddress(useContext(DocsAddressContext), path);
  if (href === undefined) {
    return null;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={accessibleName}
      data-docs-link=""
      className="rounded-xs whitespace-nowrap text-inherit underline underline-offset-2 transition-colors hover:text-foreground focus-visible:focus-ring"
    >
      {children}
      <ArrowUpRight aria-hidden="true" className="ml-0.5 inline size-3.5 align-[-0.125em]" />
    </a>
  );
}
