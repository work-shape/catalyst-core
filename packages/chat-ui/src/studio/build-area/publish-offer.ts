import {
  agentAvailabilityFormsEqual,
  agentAvailabilityToForm,
  type AgentAvailabilityForm
} from "./asset-form-model";

// OFFER-ON-PUBLISH: offering is part of publishing. The publish dialog of an agent asks where a
// chat can choose it, with only the places the reader may set, and sets the answer through
// `assets.set_availability` and its checks before it publishes.

/** Who owns the agent, as far as where it may be offered goes. */
export type PublishOfferOwner =
  | { kind: "instance" }
  | { kind: "team"; workspaceId: string }
  /** The reader's own Personal Workspace: offered nowhere beyond its owner (owner reach). */
  | { kind: "mine" };

/** One answer: as it is now, the agent's own place, or no chat yet. */
export type PublishOfferValue = "keep" | "own" | "nowhere";

export interface PublishOfferOption {
  value: PublishOfferValue;
  availability: AgentAvailabilityForm;
}

/** What the dialog shows of where the agent can be chosen. */
export type PublishOffer =
  /** "Only me": nothing wider than the owner can be chosen, so there is nothing to ask. */
  | { kind: "mine" }
  /** The reader may not set it: the place as it is, read-only, with who can. */
  | { kind: "fixed"; current: AgentAvailabilityForm }
  | {
      kind: "choice";
      options: readonly PublishOfferOption[];
      /** What holds today where the agent is offered, else its own place. */
      preselected: PublishOfferValue;
      saved: AgentAvailabilityForm;
    };

const NOWHERE: AgentAvailabilityForm = {
  mode: "selected",
  personalWorkspaces: false,
  collaborationWorkspaceIds: []
};

/** The agent's own place: every workspace for an agent of everyone, else its team. */
function ownPlace(owner: Exclude<PublishOfferOwner, { kind: "mine" }>): AgentAvailabilityForm {
  return owner.kind === "instance"
    ? { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
    : {
        mode: "selected",
        personalWorkspaces: false,
        collaborationWorkspaceIds: [owner.workspaceId]
      };
}

function offersNowhere(availability: AgentAvailabilityForm): boolean {
  return agentAvailabilityFormsEqual(availability, NOWHERE);
}

/**
 * The choice of the publish dialog. An agent offered somewhere keeps that place unless the
 * reader picks its own place instead; one offered nowhere starts at its own place, and may stay
 * in no chat. Withdrawing an offered agent stays in its "Available in" section.
 */
export function publishOffer(input: {
  owner: PublishOfferOwner;
  saved: AgentAvailabilityForm | undefined;
  /** The reader holds the right `assets.set_availability` asks for this agent. */
  maySet: boolean;
}): PublishOffer {
  if (input.owner.kind === "mine") return { kind: "mine" };
  const saved = agentAvailabilityToForm(input.saved);
  if (!input.maySet) return { kind: "fixed", current: saved };
  const own: PublishOfferOption = { value: "own", availability: ownPlace(input.owner) };
  if (offersNowhere(saved)) {
    return {
      kind: "choice",
      options: [own, { value: "nowhere", availability: NOWHERE }],
      preselected: "own",
      saved
    };
  }
  if (agentAvailabilityFormsEqual(saved, own.availability)) {
    return { kind: "choice", options: [own], preselected: "own", saved };
  }
  return {
    kind: "choice",
    options: [{ value: "keep", availability: saved }, own],
    preselected: "keep",
    saved
  };
}

/** The availability an answer sets, where it changes what is stored. */
export function offerChange(
  offer: PublishOffer,
  chosen: PublishOfferValue
): AgentAvailabilityForm | undefined {
  if (offer.kind !== "choice") return undefined;
  const option = offer.options.find((candidate) => candidate.value === chosen);
  if (option === undefined) return undefined;
  return agentAvailabilityFormsEqual(option.availability, offer.saved)
    ? undefined
    : option.availability;
}
