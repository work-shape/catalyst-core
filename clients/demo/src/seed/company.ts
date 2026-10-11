// The invented company the demo instance is filled with: Nordlicht Beratung, a small advisory
// firm with a tax, an HR and a sales team. Every name here is made up. The agents and skills of
// the company live as a config working copy under `clients/demo/seed`.

export type PersonKey = "mara" | "jonas" | "tobias" | "elif" | "sven" | "lena" | "noah";

export interface SeedPerson {
  key: PersonKey;
  displayLabel: string;
  email: string;
  roles: string[];
  /** Instance-wide rights beside the role's own, as the Users page sets them. */
  permissions: string[];
  status: "active" | "disabled";
  /** Invited by mail and never signed in: created without a password. */
  invited?: true;
}

const EMAIL_DOMAIN = "nordlicht-beratung.test";

/** The address of every person the seed creates ends with this. */
export const SEED_EMAIL_SUFFIX = `@${EMAIL_DOMAIN}`;

const person = (
  key: PersonKey,
  displayLabel: string,
  roles: string[],
  rest: Partial<Pick<SeedPerson, "permissions" | "status" | "invited">> = {}
): SeedPerson => ({
  key,
  displayLabel,
  email: `${displayLabel.toLowerCase().replace(" ", ".")}${SEED_EMAIL_SUFFIX}`,
  roles,
  permissions: [],
  status: "active",
  ...rest
});

/**
 * Two admins and five users. The instance's own seeded superadmin is the one superadmin and
 * the account the seed signs in with first.
 */
export const people: SeedPerson[] = [
  person("mara", "Mara Lindqvist", ["user", "admin"]),
  // An admin holds neither of these two rights by default.
  person("jonas", "Jonas Brandt", ["user", "admin"], {
    permissions: ["api_access.manage", "agent_models.manage"]
  }),
  person("tobias", "Tobias Keller", ["user"]),
  person("elif", "Elif Aydin", ["user"]),
  // A user holds no instance-wide right by default.
  person("sven", "Sven Olsen", ["user"], { permissions: ["config_assets.read", "usage.view"] }),
  person("lena", "Lena Hoffmann", ["user"], { status: "disabled" }),
  person("noah", "Noah Fischer", ["user"], { invited: true })
];

/** The reference every tool of the demo asks for. */
export const PERSON_PERMISSION_REFS = ["demo-tools"];

interface SeedNamespace {
  prefix: string;
  displayName: string;
  /** Left out, the Namespace does not limit tools. */
  allowedToolNames?: string[];
  /**
   * Left out, the Namespace does not limit models. Of the listed models the seed keeps the
   * ones the instance has.
   */
  allowedModelBindingIds?: string[];
  registeredBy: PersonKey;
}

export const namespaces: SeedNamespace[] = [
  {
    prefix: "tax-",
    displayName: "Steuern",
    allowedToolNames: ["read_skill", "show_view", "demo.workflow_summary"],
    allowedModelBindingIds: ["primary", "gpt56Luna"],
    registeredBy: "mara"
  },
  { prefix: "hr-", displayName: "Personal", registeredBy: "mara" },
  { prefix: "sales-", displayName: "Vertrieb / Sales", registeredBy: "jonas" }
];

type AssetKind = "agent" | "skill";
type Verb = "read" | "write" | "delete";

interface SeedGrant {
  holder: PersonKey;
  kind: AssetKind;
  verbs: Verb[];
  effect: "allow" | "deny";
  /** A registered prefix, or the name of one asset of `kind`. */
  scope: { namespace: string } | { asset: string };
  grantedBy: PersonKey;
}

export const grants: SeedGrant[] = [
  {
    holder: "tobias",
    kind: "agent",
    verbs: ["read", "write", "delete"],
    effect: "allow",
    scope: { namespace: "tax-" },
    grantedBy: "mara"
  },
  {
    holder: "tobias",
    kind: "skill",
    verbs: ["read", "write"],
    effect: "allow",
    scope: { namespace: "tax-" },
    grantedBy: "mara"
  },
  // A deny on one asset wins over the allow of its Namespace.
  {
    holder: "tobias",
    kind: "agent",
    verbs: ["write"],
    effect: "deny",
    scope: { asset: "tax-vat-checker" },
    grantedBy: "mara"
  },
  {
    holder: "elif",
    kind: "agent",
    verbs: ["read", "write", "delete"],
    effect: "allow",
    scope: { namespace: "hr-" },
    grantedBy: "mara"
  },
  {
    holder: "elif",
    kind: "skill",
    verbs: ["read", "write"],
    effect: "allow",
    scope: { namespace: "hr-" },
    grantedBy: "mara"
  },
  {
    holder: "sven",
    kind: "agent",
    verbs: ["write"],
    effect: "allow",
    scope: { asset: "sales-offer-writer" },
    grantedBy: "jonas"
  },
  {
    holder: "sven",
    kind: "skill",
    verbs: ["write"],
    effect: "allow",
    scope: { asset: "sales-offer-structure" },
    grantedBy: "jonas"
  },
  // Rows of an account that is switched off: they stay and allow nothing.
  {
    holder: "lena",
    kind: "agent",
    verbs: ["read", "write"],
    effect: "allow",
    scope: { namespace: "sales-" },
    grantedBy: "jonas"
  },
  // A deny in a Namespace wins over the admin role.
  {
    holder: "mara",
    kind: "agent",
    verbs: ["write"],
    effect: "deny",
    scope: { namespace: "hr-" },
    grantedBy: "jonas"
  }
];

/**
 * The agent with a second revision. A person saves this first draft in the interface; the
 * config push then brings the definition of the working copy as the second revision.
 */
export const firstDraft: {
  agentName: string;
  savedBy: PersonKey;
  instructions: string;
  toolNames: string[];
  skillNames: string[];
} = {
  agentName: "tax-vat-checker",
  savedBy: "jonas",
  instructions:
    "Du prüfst Ausgangsrechnungen auf die Pflichtangaben nach § 14 UStG. Erster Entwurf: noch ohne Reverse-Charge-Fälle.\n",
  toolNames: ["read_skill"],
  skillNames: []
};

/**
 * A call that waits for another person. The demo sends every new skill of the HR Namespace to
 * an approval (`demoCentralPolicySettings`), so this one lands in the Inbox of the admins.
 */
export const heldSkill: {
  requestedBy: PersonKey;
  config: { name: string; title: string; description: string; content: string };
} = {
  requestedBy: "elif",
  config: {
    name: "hr-parental-leave-faq",
    title: "Elternzeit: häufige Fragen",
    description:
      "Nutzen, wenn jemand nach Fristen, Anträgen oder Teilzeit während der Elternzeit fragt.",
    content:
      "# Elternzeit: häufige Fragen\n\n- Die Elternzeit wird spätestens sieben Wochen vor Beginn schriftlich angemeldet.\n- Teilzeit bis 32 Wochenstunden ist möglich und wird mit der Teamleitung abgestimmt.\n- Für alles, was hier nicht steht, an das HR-Team verweisen und keine Auskunft erfinden.\n"
  }
};

/** The service principal of the config CLI, the one `catalyst config local-key` creates too. */
export const cliPrincipal = {
  displayLabel: "Local config CLI",
  description: "Pushes the agents and skills of the demo from this machine.",
  permissions: ["config_assets.read", "config_assets.release"] as const,
  keyName: "local development",
  scopes: ["config_assets:read", "config_assets:release"] as const
};

/** What the Check tab answers for one action, in the tab's own reasons. */
export type CheckReason = "role" | "individual_right" | "grant" | "deny" | "no_grant" | "inactive";

interface CheckQuestion {
  person: PersonKey;
  kind: AssetKind;
  /** The name does not have to exist. */
  asset: string;
  expect: Record<Verb, { allowed: boolean; reason: CheckReason }>;
  because: string;
}

const yes = (reason: CheckReason) => ({ allowed: true, reason });
const no = (reason: CheckReason) => ({ allowed: false, reason });

/**
 * Questions for Instance > Access > Check, each with the answer the seeded rows give. The demo
 * README shows the same table and the seed's test asks every one of them.
 */
export const checkQuestions: CheckQuestion[] = [
  {
    person: "mara",
    kind: "agent",
    asset: "sales-offer-writer",
    expect: { read: yes("role"), write: yes("role"), delete: yes("role") },
    because: "An admin may change every agent."
  },
  {
    person: "mara",
    kind: "agent",
    asset: "hr-onboarding-guide",
    expect: { read: yes("role"), write: no("deny"), delete: no("deny") },
    because:
      "A deny on writing agents in `hr-` wins over her admin role, and whoever is denied writing does not delete."
  },
  {
    person: "tobias",
    kind: "agent",
    asset: "tax-deadline-planner",
    expect: { read: yes("grant"), write: yes("grant"), delete: yes("grant") },
    because: "His rows in the Namespace `tax-` allow all three."
  },
  {
    person: "tobias",
    kind: "agent",
    asset: "tax-vat-checker",
    expect: { read: yes("grant"), write: no("deny"), delete: no("deny") },
    because: "A deny on this one agent wins over the allow of its Namespace."
  },
  {
    person: "sven",
    kind: "agent",
    asset: "sales-offer-writer",
    expect: { read: yes("individual_right"), write: yes("grant"), delete: no("no_grant") },
    because:
      "He reads through the right set on the Users page and writes through a row on this one agent."
  },
  {
    person: "sven",
    kind: "agent",
    asset: "sales-pitch-coach",
    expect: { read: yes("individual_right"), write: no("no_grant"), delete: no("no_grant") },
    because: "His write row names another agent, and nothing covers this one."
  },
  {
    person: "elif",
    kind: "agent",
    asset: "hr-exit-interview",
    expect: { read: yes("grant"), write: yes("grant"), delete: yes("grant") },
    because: "The agent does not exist yet. Her rows in `hr-` would let her create it."
  },
  {
    person: "elif",
    kind: "skill",
    asset: "tax-vat-rules",
    expect: { read: no("no_grant"), write: no("no_grant"), delete: no("no_grant") },
    because: "Her rows end at the Namespace `hr-`."
  },
  {
    person: "lena",
    kind: "agent",
    asset: "sales-pitch-coach",
    expect: { read: no("inactive"), write: no("inactive"), delete: no("inactive") },
    because: "Her account is deactivated, so her rows in `sales-` allow nothing."
  }
];
