import { Chip, Picker, PickerButton, SkillIcon } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { MoreRead } from "./paged-items";
import type { SkillFacts } from "./skill-facts";

/** The skills an agent can be given, as far as the instance was asked for them. */
export interface SkillChoice {
  /** The skills that match what the reader typed, the pages read so far. */
  options: readonly ({ name: string; title: string } & SkillFacts)[];
  /** Present while more skills match: the chooser's last row reads the next page. */
  more?: MoreRead;
  /** The reader typed into the search: the instance is asked for the skills that match. */
  onSearch(text: string): void;
  /**
   * Skills the reader sees that this agent cannot use, such as their own for an agent of
   * everyone: shown greyed with the reason instead of hidden (SCOPE-WORDS).
   */
  unusable?: readonly ({
    name: string;
    title: string;
    reason: string;
    /** "Für alle teilen…": shares the skill up to the agent's place (SHARE-1). */
    share?: { label: string; onSelect(): void };
  } & SkillFacts)[];
}

/** The skills an agent works with: one chip per chosen skill and the chooser. */
export function AgentSkills({
  choice,
  value,
  editable,
  onChange
}: {
  choice: SkillChoice;
  value: readonly string[];
  editable: boolean;
  onChange(skillNames: string[]): void;
}) {
  const { t } = useTranslation();
  const byName = new Map(choice.options.map((skill) => [skill.name, skill]));
  return (
    <>
      {value.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("build.noSkillsChosen")}</p>
      ) : (
        <ul aria-label={t("configSkills")} className="flex flex-wrap gap-2">
          {value.map((name) => (
            <li key={name}>
              <Chip
                leading={<SkillIcon icon={byName.get(name)?.icon} size="sm" />}
                onRemove={
                  editable ? () => onChange(value.filter((entry) => entry !== name)) : undefined
                }
              >
                {byName.get(name)?.title || name}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <div>
          <Picker
            multiple
            search
            wrapDescriptions
            className="w-120"
            label={t("build.chooseSkills")}
            note={t("build.skillsNote")}
            onSearchChange={choice.onSearch}
            // A skill without a summary shows its title alone. Its id is never shown and is
            // still found by the search.
            options={[
              ...choice.options.map((skill) => ({
                value: skill.name,
                label: skill.title || skill.name,
                description: skill.summary,
                keywords: skill.name,
                leading: <SkillIcon icon={skill.icon} />
              })),
              ...(choice.unusable ?? [])
                .filter((skill) => !byName.has(skill.name))
                .map((skill) => ({
                  value: skill.name,
                  label: skill.title || skill.name,
                  disabledReason: skill.reason,
                  ...(skill.share === undefined ? {} : { disabledAction: skill.share }),
                  keywords: skill.name,
                  leading: <SkillIcon icon={skill.icon} />
                }))
            ]}
            more={choice.more && { loading: choice.more.loading, onLoad: choice.more.load }}
            value={value}
            onValueChange={onChange}
          >
            <PickerButton
              label={t("configSkills")}
              placeholder={t("build.chooseSkills")}
              value={undefined}
            />
          </Picker>
        </div>
      ) : null}
    </>
  );
}
