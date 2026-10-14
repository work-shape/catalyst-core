// The invented company the demo instance is filled with: Nordlicht Beratung, a small advisory
// firm with a tax, an HR and a sales team. Every name here is made up. The agents and skills of
// the company live as a config working copy under `clients/demo/seed`.

export type PersonKey = "mara" | "jonas" | "tobias" | "elif" | "sven" | "lena" | "noah" | "kai";

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
 * Two admins and six users. The instance's own seeded superadmin is the one superadmin and
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
  person("noah", "Noah Fischer", ["user"], { invited: true }),
  // A member who builds: his rows in his own Namespace are all he holds.
  person("kai", "Kai Berger", ["user"])
];

/** The seeded person of a key. */
export function personOf(key: PersonKey): SeedPerson {
  const found = people.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`The seed has no person '${key}'`);
  return found;
}

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
  { prefix: "sales-", displayName: "Vertrieb / Sales", registeredBy: "jonas" },
  { prefix: "kai-", displayName: "Kai", registeredBy: "mara" }
];

/**
 * The Shared Workspace of the company. Everything a workspace owns is seeded into it; the Apps
 * are the first of that.
 */
export const workspace: {
  name: string;
  description: string;
  createdBy: PersonKey;
  members: PersonKey[];
} = {
  name: "Nordlicht Beratung",
  description: "The whole firm: what every team uses.",
  createdBy: "mara",
  members: ["jonas", "tobias", "elif", "sven"]
};

interface SeedApp {
  /** The id of the App, and its folder under `seed/apps`. */
  name: string;
  /**
   * The source sets the App is written from, in order: the folders `seed/apps/<name>/<set>`.
   * Each write is one revision.
   */
  sourceSets: string[];
  /** How many of the source sets are written before the App is published. */
  publishedAfter: number;
  savedBy: PersonKey;
  /**
   * The Connection the App's actions call. An instance without it cannot store the App, so
   * the seed leaves the App out there and says so.
   */
  connection?: string;
}

/**
 * One App that is published, one whose draft is a revision ahead of what is published, and
 * one whose tile reads rows of the sample business system through a named action.
 */
export const apps: SeedApp[] = [
  { name: "client-onboarding", sourceSets: ["1"], publishedAfter: 1, savedBy: "mara" },
  { name: "fee-estimate", sourceSets: ["1", "2"], publishedAfter: 1, savedBy: "mara" },
  {
    name: "customer-list",
    sourceSets: ["1"],
    publishedAfter: 1,
    savedBy: "mara",
    connection: "sample-business"
  }
];

type AssetKind = "agent" | "skill";
type Verb = "read" | "write" | "delete";

interface SeedGrant {
  holder: PersonKey;
  kind: AssetKind | "workflow";
  /** A Workflow has no row for deleting it: that stays with the role. */
  verbs: (Verb | "publish")[];
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
  },
  // Kai Berger builds in his own Namespace. No grant gives a right on Apps yet: an App
  // belongs to a workspace, and a Namespace row never reaches one.
  {
    holder: "kai",
    kind: "agent",
    verbs: ["read", "write", "delete"],
    effect: "allow",
    scope: { namespace: "kai-" },
    grantedBy: "mara"
  },
  {
    holder: "kai",
    kind: "skill",
    verbs: ["read", "write", "delete"],
    effect: "allow",
    scope: { namespace: "kai-" },
    grantedBy: "mara"
  },
  {
    holder: "kai",
    kind: "workflow",
    verbs: ["read", "write", "publish"],
    effect: "allow",
    scope: { namespace: "kai-" },
    grantedBy: "mara"
  }
];

/** The Connection of the demo's release config, the sample business system. */
export const SEEDED_CONNECTION = "sample-business";

interface SeedConnectionGrant {
  holder: PersonKey;
  verbs: ("read" | "use")[];
  grantedBy: PersonKey;
}

/**
 * Who may use the Connection beside the admins, who hold every right on it by their role. A
 * user holds none, so an agent of anybody else is refused when it calls one of its tools.
 */
export const connectionGrants: SeedConnectionGrant[] = [
  // Sales reads the business figures and sees the Connection under Studio.
  { holder: "sven", verbs: ["read", "use"], grantedBy: "jonas" },
  // Tax may ask an agent for the figures and does not see the Connection itself.
  { holder: "tobias", verbs: ["use"], grantedBy: "mara" }
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
 * A call that waits for an approval. The demo holds every skill saved into the HR Namespace
 * (`demoOperations`), and the person who saves this one does not hold `operations.approve`,
 * so it lands in the Inbox of those who do.
 *
 * Why Elif Aydin wants it: the HR team answers the same three questions about parental leave
 * every month, and the absence desk agent has nothing to answer them from. A request carries
 * no comment of the person who made it, so this stands here and not in the Inbox.
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

/**
 * A second call that waits: one paragraph of a skill the seed pushed is replaced, so the Inbox
 * shows a change as before and after. The seed asks for it only while the request above
 * waits, which is how it knows that the instance holds such a call and does not write it.
 */
export const heldSkillChange: {
  requestedBy: PersonKey;
  skillName: string;
  /** A whole paragraph of the skill under `seed/`, and what replaces it. */
  before: string;
  after: string;
} = {
  requestedBy: "elif",
  skillName: "hr-leave-policy",
  before: "Niemand muss eine Diagnose nennen.",
  after:
    "Eine Diagnose muss niemand nennen. Die Krankmeldung geht an die Teamleitung und an das HR-Team, nicht an das ganze Team."
};

/**
 * What the member who builds made himself, in his own session, so each carries his name: one
 * agent, and one Workflow left as a draft, a folder under `seed/workflows`. A definition must
 * name a principal under `runAs`, and a draft lends nothing: making it live asks what
 * administering service principals asks, which he does not hold. So it stays a draft.
 */
export const builder: {
  person: PersonKey;
  agent: {
    name: string;
    displayName: { de: string; en: string };
    description: { de: string; en: string };
    instructions: string;
    toolNames: string[];
  };
  workflow: string;
} = {
  person: "kai",
  agent: {
    name: "kai-helper",
    displayName: { de: "Kais Helfer", en: "Kai's helper" },
    description: {
      de: "Kais erster eigener Agent: kurze Antworten zu seinen Notizen.",
      en: "Kai's first agent of his own: short answers about his notes."
    },
    // No model setting: choosing a model asks `agent_models.manage`, so his agent takes the
    // instance's default.
    instructions:
      "You help Kai Berger sort his notes. Answer briefly and in the language of the question.\n",
    toolNames: ["read_skill"]
  },
  workflow: "kai-skill-inventory"
};

/**
 * The service principal the seeded Workflows run as. A run acts with its rights and with
 * nobody else's: it reads agents and skills and nothing more. `name` is what a definition
 * names under `runAs`.
 */
export const workflowPrincipal = {
  name: "workflow-demo",
  displayLabel: "Workflow demo",
  description: "The Workflows of the demo run as this principal. It reads agents and skills.",
  permissions: ["config_assets.read"] as const
};

/** The Workflows of the demo, each a folder under `seed/workflows` with its `workflow.yaml`. */
export const workflows = ["agent-inventory"] as const;

/** The service principal of the config CLI, the one `catalyst-local-key` creates too. */
export const cliPrincipal = {
  displayLabel: "Local config CLI",
  description: "Pushes the agents and skills of the demo from this machine.",
  permissions: ["config_assets.read", "config_assets.release"] as const,
  keyName: "local development",
  scopes: ["config_assets:read", "config_assets:release"] as const
};

/** What the Check tab answers for one action, in the tab's own reasons. */
export type CheckReason = "role" | "individual_right" | "grant" | "deny" | "no_grant" | "inactive";

interface CheckQuestion<Kind extends string = AssetKind, Action extends string = Verb> {
  person: PersonKey;
  kind: Kind;
  /** The name does not have to exist. */
  asset: string;
  expect: Record<Action, { allowed: boolean; reason: CheckReason }>;
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
    expect: { read: yes("grant"), write: yes("grant"), delete: no("no_grant") },
    because:
      "He reads through the instance-wide right set on the Users page and writes through a row on this one agent."
  },
  {
    person: "sven",
    kind: "agent",
    asset: "sales-pitch-coach",
    expect: { read: yes("grant"), write: no("no_grant"), delete: no("no_grant") },
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
  },
  {
    person: "kai",
    kind: "agent",
    asset: "kai-helper",
    expect: { read: yes("grant"), write: yes("grant"), delete: yes("grant") },
    because: "He made this agent in his own Namespace `kai-`, where his rows allow all three."
  },
  {
    person: "kai",
    kind: "skill",
    asset: "plain-language",
    expect: { read: no("no_grant"), write: no("no_grant"), delete: no("no_grant") },
    because: "His rows end at his Namespace `kai-`, and he holds no right beside them."
  }
];

/**
 * The same for a Workflow, which has a further action: starting it. Publishing is a row of
 * its own on the Rights tab and not a question of the Check tab. An instance answers these
 * only with the module `workflows` on.
 */
export const workflowCheckQuestions: CheckQuestion<"workflow", Verb | "use">[] = [
  {
    person: "kai",
    kind: "workflow",
    asset: builder.workflow,
    expect: {
      read: yes("grant"),
      use: no("no_grant"),
      write: yes("grant"),
      delete: no("no_grant")
    },
    because:
      "His rows in `kai-` let him read and change his draft. He holds no row for starting it, and deleting a Workflow stays with the role."
  }
];

/**
 * The same for the Connection, which has a fourth action: using it. An instance answers these
 * only with the module `connections` on, as the demo's own config has it.
 */
export const connectionCheckQuestions: CheckQuestion<"connection", Verb | "use">[] = [
  {
    person: "tobias",
    kind: "connection",
    asset: SEEDED_CONNECTION,
    expect: {
      read: no("no_grant"),
      use: yes("grant"),
      write: no("no_grant"),
      delete: no("no_grant")
    },
    because:
      "His row on this Connection allows using it: his agents get its data. He does not see it under Studio."
  },
  {
    person: "sven",
    kind: "connection",
    asset: SEEDED_CONNECTION,
    expect: {
      read: yes("grant"),
      use: yes("grant"),
      write: no("no_grant"),
      delete: no("no_grant")
    },
    because: "His rows on this Connection allow reading and using it, and nothing more."
  },
  {
    person: "elif",
    kind: "connection",
    asset: SEEDED_CONNECTION,
    expect: {
      read: no("no_grant"),
      use: no("no_grant"),
      write: no("no_grant"),
      delete: no("no_grant")
    },
    because: "She holds no row on the Connection, so her agents are refused its tools."
  },
  {
    person: "mara",
    kind: "connection",
    asset: SEEDED_CONNECTION,
    expect: { read: yes("role"), use: yes("role"), write: yes("role"), delete: yes("role") },
    because: "An admin holds every right on a Connection by the role."
  }
];
