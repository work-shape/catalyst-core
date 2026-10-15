import type { ConfigAssetReferences } from "@work-shape/catalyst-api-client";
import {
  CodeBlock,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../i18n";

type Instructions = NonNullable<ConfigAssetReferences["platformInstructions"]>;

interface PlatformInstructionsProps {
  instructions: ConfigAssetReferences["platformInstructions"];
  /** The tools of the agent as it is saved. */
  toolNames: readonly string[];
}

/**
 * What the platform tells the agent before its own instructions, read-only and as the agent gets
 * them: the rules every agent gets, and the orientation while its saved tools name one of the
 * platform's. They come with the release; nothing here edits them.
 */
export function PlatformInstructions({ instructions, toolNames }: PlatformInstructionsProps) {
  const { t } = useTranslation();
  if (!instructions) return null;
  return (
    <Disclosure variant="outline" data-platform-instructions="">
      <DisclosureTrigger>{t("configPlatformInstructions")}</DisclosureTrigger>
      <DisclosureContent>
        <PlatformInstructionsBody instructions={instructions} toolNames={toolNames} />
      </DisclosureContent>
    </Disclosure>
  );
}

/** What the disclosure folds away. */
export function PlatformInstructionsBody({
  instructions,
  toolNames
}: {
  instructions: Instructions;
  toolNames: readonly string[];
}) {
  const { t } = useTranslation();
  const holdsPlatformTools = toolNames.some((name) => instructions.toolNames.includes(name));
  return (
    <>
      <p className="text-muted-foreground">{t("configPlatformInstructionsHint")}</p>
      <p className="pt-2 text-label">{t("configPlatformRules")}</p>
      <CodeBlock
        label={t("configPlatformRules")}
        code={instructions.rules}
        wrap
        lineNumbers={false}
      />
      <p className="pt-2 text-label">{t("configPlatformOrientation")}</p>
      {holdsPlatformTools ? (
        <CodeBlock
          label={t("configPlatformOrientation")}
          code={instructions.orientation}
          wrap
          lineNumbers={false}
        />
      ) : (
        <p className="text-muted-foreground">{t("configPlatformOrientationNone")}</p>
      )}
    </>
  );
}
