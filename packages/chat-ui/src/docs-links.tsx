import { DocsLink } from "@vivd-catalyst/ui";
import { useTranslation, type TranslationKey } from "./i18n";

/**
 * The pages of the documentation the interface links to, as paths under the instance's
 * documentation address. A page or a heading that moves is changed here and nowhere else.
 */
const DOCS_PAGES = {
  rightsInShort: "/operate/how-rights-work/#the-short-version",
  namespaceOrWorkspace: "/operate/how-rights-work/#namespace-or-workspace",
  rightDecision: "/operate/how-rights-work/#do-you-hold-the-right-here"
} as const;

interface DocsReferenceDefinition {
  page: keyof typeof DOCS_PAGES;
  /** "Learn more" after a sentence; a name of its own where the link stands alone. */
  label: TranslationKey;
  /** The label, its topic and that it opens a new tab. */
  accessibleName: TranslationKey;
}

/** Every link from a page into the documentation, named for the place it stands in. */
const DOCS_REFERENCES = {
  accessPage: {
    page: "rightsInShort",
    label: "docs.howRightsWork",
    accessibleName: "docs.howRightsWorkName"
  },
  rightPlace: {
    page: "namespaceOrWorkspace",
    label: "docs.namespaceOrWorkspace",
    accessibleName: "docs.namespaceOrWorkspaceName"
  },
  rightDenied: {
    page: "rightDecision",
    label: "docs.learnMore",
    accessibleName: "docs.learnMoreDenyName"
  },
  rightsCheck: {
    page: "rightDecision",
    label: "docs.learnMore",
    accessibleName: "docs.learnMoreCheckName"
  },
  buildReadOnly: {
    page: "rightDecision",
    label: "docs.learnMore",
    accessibleName: "docs.learnMoreReadOnlyName"
  }
} as const satisfies Record<string, DocsReferenceDefinition>;

type DocsReferenceName = keyof typeof DOCS_REFERENCES;

/**
 * One link into the documentation. It shows nothing on an instance without a documentation
 * address, so the text before it is written to be complete alone.
 */
export function DocsReference({ to }: { to: DocsReferenceName }) {
  const { t } = useTranslation();
  const reference = DOCS_REFERENCES[to];
  return (
    <DocsLink path={DOCS_PAGES[reference.page]} accessibleName={t(reference.accessibleName)}>
      {t(reference.label)}
    </DocsLink>
  );
}
