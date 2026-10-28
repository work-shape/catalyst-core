import { useEffect, useEffectEvent, useId, useState } from "react";
import { RadioGroup, type RadioOption } from "@work-shape/catalyst-ui";
import { actionLabel } from "../../admin/access/right-words";
import { useTranslation } from "../../shared/i18n";
import { assetPlace, offeredPlaces, useKnownWorkspaces } from "./asset-place";
import type { AgentAvailabilityForm } from "./asset-form-model";
import type { DependencyAvailability } from "./dependency-availability";
import type { PublishOffer, PublishOfferOption, PublishOfferValue } from "./publish-offer";

/**
 * "Can be chosen in" of the publish dialog (OFFER-ON-PUBLISH): the places the reader may set,
 * the one that holds now or the agent's own preselected. A reader without the right reads it
 * as it is, with who can change it; an agent of "Only me" is offered to nobody else.
 */
export function PublishOfferField({
  offer,
  value,
  disabled,
  onValueChange
}: {
  offer: PublishOffer;
  value: PublishOfferValue;
  disabled: boolean;
  onValueChange(value: PublishOfferValue): void;
}) {
  const { locale, t } = useTranslation();
  const workspaces = useKnownWorkspaces();
  const labelId = useId();
  const label = t("build.offerLabel");
  const placesOf = (option: PublishOfferOption["availability"]) =>
    offeredPlaces(option, workspaces, t, locale) ?? t("build.offerNowhere");

  if (offer.kind === "mine") {
    return (
      <div role="group" aria-labelledby={labelId} className="grid gap-1" data-publish-offer="mine">
        <span id={labelId} className="text-label">
          {label}
        </span>
        <p className="text-caption text-muted-foreground">{t("build.availabilityOnlyMine")}</p>
      </div>
    );
  }
  if (offer.kind === "fixed") {
    return (
      <RadioGroup
        variant="plain"
        label={label}
        disabled
        value="current"
        data-publish-offer="fixed"
        options={[{ value: "current", label: placesOf(offer.current) }]}
        hint={t("build.offerNeedsRight", { right: actionLabel("agent.write", t) })}
      />
    );
  }
  const options = offer.options.map((option): RadioOption<PublishOfferValue> => {
    if (option.value === "nowhere") {
      return {
        value: "nowhere",
        label: t("build.offerNowhere"),
        description: t("build.offerNowhereHint")
      };
    }
    if (option.value === "keep") {
      return {
        value: "keep",
        label: placesOf(option.availability),
        description: t("build.offerKeepHint")
      };
    }
    // The agent's own place: every workspace, or its team by the name Studio shows.
    const team = option.availability.collaborationWorkspaceIds[0];
    return option.availability.mode === "all" || team === undefined
      ? {
          value: "own",
          label: t("configAvailabilityAll"),
          description: t("configAvailabilityAllHint")
        }
      : {
          value: "own",
          label: assetPlace({ kind: "workspace", workspaceId: team }, workspaces, t).name,
          description: t("build.offerTeamHint")
        };
  });
  return (
    <RadioGroup
      variant="plain"
      label={label}
      value={value}
      disabled={disabled}
      data-publish-offer="choice"
      onValueChange={onValueChange}
      options={options}
    />
  );
}

/** What the dialog reads for the place an answer offers the draft in. */
interface OfferDependenciesRead {
  read(
    config: Record<string, unknown>,
    form: AgentAvailabilityForm,
    signal: AbortSignal
  ): Promise<DependencyAvailability | null>;
  config: Record<string, unknown>;
  form: AgentAvailabilityForm;
}

/**
 * What the draft would use that members could not use where the answer offers it, read again
 * for each answer. Nothing is read while the answer keeps the place: the publish read says it.
 * A read that fails lists nothing, as most places miss nothing.
 */
export function useOfferDependencies(input: OfferDependenciesRead | undefined): {
  data: DependencyAvailability | undefined;
  isPending: boolean;
} {
  const key = input === undefined ? undefined : JSON.stringify([input.config, input.form]);
  const [answer, setAnswer] = useState<{ key: string; data: DependencyAvailability | undefined }>();
  const read = useEffectEvent((signal: AbortSignal) =>
    input === undefined ? Promise.resolve(null) : input.read(input.config, input.form, signal)
  );
  useEffect(() => {
    if (key === undefined) return undefined;
    const controller = new AbortController();
    read(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setAnswer({ key, data: data ?? undefined });
      },
      () => {
        if (!controller.signal.aborted) setAnswer({ key, data: undefined });
      }
    );
    return () => controller.abort();
  }, [key]);
  if (key === undefined) return { data: undefined, isPending: false };
  return answer?.key === key
    ? { data: answer.data, isPending: false }
    : { data: undefined, isPending: true };
}
