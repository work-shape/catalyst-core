import type { ReactNode } from "react";
import { Button, EmptyState, Starter, StarterList } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../shared/i18n";

/** One thing a business builds of a kind: a starter whose prompt opens the agent with it. */
interface BuildExample {
  icon: ReactNode;
  title: TranslationKey;
  hint: TranslationKey;
  prompt: TranslationKey;
}

/** What an empty list of a kind an agent builds says to a person who may build there. */
export interface BuildWithAgentCopy {
  /** How one comes to be. */
  text: TranslationKey;
  /** "Build one with the agent", in the grammar of the kind. */
  action: TranslationKey;
  /** The started sentence the action puts in the composer, as the kind's New button does. */
  prompt: TranslationKey;
  examples: readonly [BuildExample, BuildExample];
}

/**
 * The empty list of Apps, Workflows or Data Stores (UXA-3b). A person who may build there is
 * offered the agent with two examples, each opening it with its own start; everybody else reads
 * one sentence on what the kind is, and never that a builder could add one.
 */
export function BuildWithAgentEmptyState({
  icon,
  readerText,
  copy,
  onBuild
}: {
  icon: ReactNode;
  /** One sentence on what the kind is. */
  readerText: TranslationKey;
  copy: BuildWithAgentCopy;
  /** Opens the agent with this text in its composer. Absent where the person may not build. */
  onBuild?(prompt: string): void;
}) {
  const { t } = useTranslation();
  if (!onBuild) {
    return <EmptyState icon={icon}>{t(readerText)}</EmptyState>;
  }
  return (
    <EmptyState
      icon={icon}
      action={<Button onClick={() => onBuild(t(copy.prompt))}>{t(copy.action)}</Button>}
      presets={
        <StarterList label={t("build.examples")} className="w-full">
          {copy.examples.map((example) => (
            <Starter
              key={example.title}
              icon={example.icon}
              title={t(example.title)}
              hint={t(example.hint)}
              onClick={() => onBuild(t(example.prompt))}
            />
          ))}
        </StarterList>
      }
    >
      {t(copy.text)}
    </EmptyState>
  );
}
