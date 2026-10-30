import {
  WORKFLOW_STEP_DATA_MAX_BYTES,
  type ConnectionConfig,
  type ConnectionOperationEffect,
  type ConnectorTypeDefinition,
  type WorkflowCapabilityUnit,
  type WorkflowCodeStepAvailability,
  type WorkflowPackageManifestState
} from "@work-shape/catalyst-core";
import { WORKFLOW_CODE_LANGUAGES } from "./code-step";
import { WORKFLOW_DEFINITION_MAX_STEPS, WORKFLOW_MANIFEST_MAX_BYTES } from "./limits";
import type { WorkflowRunnerPackage } from "./runner-packages";

// What a Workflow can do on this release (WF-FIT): one list that the Build Agent's fit check
// reads through `workflows.capabilities`, and that the page "What a Workflow can do" is
// written from, in the instance with its own values and in the product docs with the release
// defaults. It says only what this release has built: a later step of "A Workflow carries a
// customer's own software" adds its part here and removes its line from `notOffered`.

export type { WorkflowCapabilityUnit } from "@work-shape/catalyst-core";

/** One bound of a Workflow, with the setting that raises it where an operator can. */
export interface WorkflowCapabilitySetting {
  /** The release config key, such as `workflows.codeSteps.memoryBytes`. Absent for a fixed bound. */
  key?: string;
  value: number | string;
  unit: WorkflowCapabilityUnit;
  /** What it bounds, in one line. */
  about: string;
}

/** A Connection the asker may use, as a Workflow reaches it. */
export interface WorkflowCapabilityConnection {
  name: string;
  title: string;
  connectorType: string;
  /** A switched-off Connection answers no call. */
  enabled: boolean;
  /**
   * The operations exposed to `workflow`, which an `operation` step calls. A changing one runs
   * only where it is `enabled`: an administrator switches it on.
   */
  operations: { name: string; effect: ConnectionOperationEffect; enabled: boolean }[];
  /** How many of its operations are not exposed to `workflow`; an administrator can expose them. */
  otherOperations: number;
}

export interface WorkflowCapabilities {
  runtime: {
    codeSteps: WorkflowCodeStepAvailability;
    /** The languages of the runner image a code step's entry is written in. */
    languages: { language: string; command: string; endings: string[] }[];
    /** The runner image's pinned packages a Workflow may declare under `packages`. */
    packages: WorkflowRunnerPackage[];
    packageManifest: WorkflowPackageManifestState;
  };
  /** The resource ceilings of a run and of its steps. */
  ceilings: WorkflowCapabilitySetting[];
  /** The bounds of a Workflow's source tree. */
  source: WorkflowCapabilitySetting[];
  reach: {
    /** What a `code` step reaches on this release: nothing outside its container. */
    codeSteps: "none";
    /** The Connections the asker may use, by name. */
    connections: WorkflowCapabilityConnection[];
    /** The installed Connector types that have changing operations. */
    changingConnectorTypes: string[];
  };
  /** What a Workflow cannot do on this release, each with a stable id. */
  notOffered: { id: string; text: string }[];
}

/** The numbers of release config `workflows` the list reads. */
export interface WorkflowCapabilitiesConfig {
  stepSlots: number;
  codeSteps: {
    slots: number;
    memoryBytes: number;
    cpuCount: number;
    pidsLimit: number;
    timeoutSeconds: number;
    scratchBytes: number;
    diskBytes: number;
  };
  limits: {
    duration: string;
    stepRuns: number;
    loopItems: number;
    datasetBytes: number;
    pagedStepMinutes: number;
  };
  datasets: {
    rows: number;
    bytes: number;
    rowBytes: number;
    runBytes: number;
    instanceBytes: number;
  };
  source: { fileBytes: number; files: number; treeBytes: number; historyBytes: number };
}

/** Lines of `notOffered` this release always has; a later step removes its own. */
const NOT_OFFERED_ON_THIS_RELEASE = [
  {
    // Removed by WF-REACH-HTTP (step 2).
    id: "code_step_http",
    text: "A code step reaches no HTTP API, not even a Connection's: its container has no network. Call the Connection from an operation step and hand the result to the code step."
  },
  {
    // Removed by WF-REACH-PG (step 4).
    id: "code_step_postgres",
    text: "A code step does not reach a postgres Connection's database. Read it through an operation step."
  },
  {
    id: "inbound_network",
    text: "No inbound network and no listening server: a step serves no requests. A Workflow starts by hand, on a schedule, from a webhook or from a platform event."
  },
  { id: "gpu", text: "No GPU." },
  {
    // Removed by WF-RUNNER (step 5).
    id: "customer_network",
    text: "No host that only the customer's own network reaches: steps run on the platform's hosts and reach a system only through a Connection."
  },
  {
    id: "package_install",
    text: "No package is installed at publish or run time: a code step imports the runner image's packages, and another one needs a runner image release."
  }
] as const;

const setting = (
  key: string | undefined,
  value: number | string,
  unit: WorkflowCapabilityUnit,
  about: string
): WorkflowCapabilitySetting => ({ ...(key === undefined ? {} : { key }), value, unit, about });

/** The ceilings and source bounds of release config, in the order the page shows them. */
function settingsOf(config: WorkflowCapabilitiesConfig): {
  ceilings: WorkflowCapabilitySetting[];
  source: WorkflowCapabilitySetting[];
} {
  const { codeSteps, limits, datasets, source } = config;
  const code = "workflows.codeSteps";
  return {
    ceilings: [
      setting(`${code}.memoryBytes`, codeSteps.memoryBytes, "bytes", "Memory of one code step"),
      setting(`${code}.cpuCount`, codeSteps.cpuCount, "cpus", "CPUs of one code step"),
      setting(
        `${code}.timeoutSeconds`,
        codeSteps.timeoutSeconds,
        "seconds",
        "Run time of one code step"
      ),
      setting(
        `${code}.diskBytes`,
        codeSteps.diskBytes,
        "bytes",
        "Disk of one code step: its input datasets and what it writes"
      ),
      setting(
        `${code}.scratchBytes`,
        codeSteps.scratchBytes,
        "bytes",
        "Working directory of a script, part of its memory"
      ),
      setting(
        `${code}.pidsLimit`,
        codeSteps.pidsLimit,
        "count",
        "Processes and threads of one code step"
      ),
      setting(
        `${code}.slots`,
        codeSteps.slots,
        "count",
        "Code steps one command worker runs at once"
      ),
      setting(
        "workflows.stepSlots",
        config.stepSlots,
        "count",
        "Steps one process runs at once; the most `limits.concurrency` may set"
      ),
      setting(
        "workflows.limits.duration",
        limits.duration,
        "duration",
        "The most a Workflow's `limits.duration` may set for one run"
      ),
      setting(
        "workflows.limits.stepRuns",
        limits.stepRuns,
        "count",
        "The most a Workflow's `limits.stepRuns` may set for one run"
      ),
      setting(
        "workflows.limits.loopItems",
        limits.loopItems,
        "count",
        "The most a Workflow's `limits.loopItems` may set for one loop"
      ),
      setting(
        "workflows.limits.datasetBytes",
        limits.datasetBytes,
        "bytes",
        "The most a Workflow's `limits.datasetBytes` may set for one dataset"
      ),
      setting(
        "workflows.limits.pagedStepMinutes",
        limits.pagedStepMinutes,
        "minutes",
        "The most a Workflow's `limits.pagedStepMinutes` may set for one paged step"
      ),
      setting("workflows.datasets.bytes", datasets.bytes, "bytes", "One dataset"),
      setting("workflows.datasets.rows", datasets.rows, "count", "Rows of one dataset"),
      setting(
        "workflows.datasets.rowBytes",
        datasets.rowBytes,
        "bytes",
        "Size of one row of a dataset"
      ),
      setting(
        "workflows.datasets.runBytes",
        datasets.runBytes,
        "bytes",
        "Datasets of one run together"
      ),
      setting(
        "workflows.datasets.instanceBytes",
        datasets.instanceBytes,
        "bytes",
        "Datasets of the instance together"
      ),
      setting(
        undefined,
        WORKFLOW_STEP_DATA_MAX_BYTES,
        "bytes",
        "One value a step hands the next inline; more goes into a dataset"
      )
    ],
    source: [
      setting(
        "workflows.source.fileBytes",
        source.fileBytes,
        "bytes",
        "One file of a Workflow's tree"
      ),
      setting("workflows.source.files", source.files, "count", "Files of a Workflow's tree"),
      setting(
        "workflows.source.treeBytes",
        source.treeBytes,
        "bytes",
        "A Workflow's tree together"
      ),
      setting(
        "workflows.source.historyBytes",
        source.historyBytes,
        "bytes",
        "A Workflow's history"
      ),
      setting(undefined, WORKFLOW_MANIFEST_MAX_BYTES, "bytes", "workflow.yaml"),
      setting(
        undefined,
        WORKFLOW_DEFINITION_MAX_STEPS,
        "count",
        "Steps of one definition, those of its loops and blocks among them"
      )
    ]
  };
}

/** The languages of the runner image, each once, with the endings of its files. */
function languagesOf(): WorkflowCapabilities["runtime"]["languages"] {
  const languages = new Map<string, { language: string; command: string; endings: string[] }>();
  for (const [ending, { language, command }] of Object.entries(WORKFLOW_CODE_LANGUAGES)) {
    const known = languages.get(language) ?? { language, command, endings: [] };
    known.endings.push(`.${ending}`);
    languages.set(language, known);
  }
  return [...languages.values()];
}

/**
 * Whether a Connection of the type may have a changing operation: one of its catalog does, a
 * discovering type's outside system may propose one, and a declaring type accepts a changing
 * declaration.
 */
export function connectorTypeChanges(type: ConnectorTypeDefinition): boolean {
  if (type.catalog) return type.catalog.some((entry) => entry.proposedEffect === "changing");
  if (type.discover) return true;
  return !type.declared
    .issues({ name: "probe", effect: "changing", exposure: ["workflow"], enabled: true })
    .some((issue) => issue.path?.[0] === "effect");
}

/** A Connection as the list shows it to someone who may use it. */
export function workflowCapabilityConnection(
  connection: Pick<
    ConnectionConfig,
    "name" | "displayName" | "connectorType" | "enabled" | "operations"
  >
): WorkflowCapabilityConnection {
  const exposed = connection.operations.filter((operation) =>
    operation.exposure.includes("workflow")
  );
  return {
    name: connection.name,
    title: connection.displayName,
    connectorType: connection.connectorType,
    enabled: connection.enabled,
    operations: exposed.map(({ name, effect, enabled }) => ({ name, effect, enabled })),
    otherOperations: connection.operations.length - exposed.length
  };
}

/** The capability list of one instance, or with the release's defaults for the product docs. */
export function describeWorkflowCapabilities(input: {
  config: WorkflowCapabilitiesConfig;
  codeSteps: WorkflowCapabilities["runtime"]["codeSteps"];
  packages: {
    packages: readonly WorkflowRunnerPackage[];
    unavailable?: Exclude<WorkflowPackageManifestState, "available">;
  };
  /** The Connections the asker may use. */
  connections: readonly WorkflowCapabilityConnection[];
  connectorTypes: readonly ConnectorTypeDefinition[];
}): WorkflowCapabilities {
  const changing = input.connectorTypes.filter(connectorTypeChanges).map(({ type }) => type);
  const readOnly = input.connectorTypes
    .filter(({ type }) => !changing.includes(type))
    .map(({ type }) => type);
  return {
    runtime: {
      codeSteps: input.codeSteps,
      languages: languagesOf(),
      packages: [...input.packages.packages],
      packageManifest: input.packages.unavailable ?? "available"
    },
    ...settingsOf(input.config),
    reach: {
      codeSteps: "none",
      connections: [...input.connections].sort((left, right) =>
        left.name.localeCompare(right.name)
      ),
      changingConnectorTypes: changing
    },
    notOffered: [
      ...(input.codeSteps === "no_sandbox"
        ? [
            {
              id: "code_steps",
              text: "This instance runs no code steps: it has no sandbox. A code step fails at once."
            }
          ]
        : []),
      ...NOT_OFFERED_ON_THIS_RELEASE,
      ...readOnly.map((type) => ({
        id: `changing_${type}`,
        text: `Connections of type ${type} only read: none of its operations changes data.`
      }))
    ]
  };
}

const BYTE_UNITS = ["bytes", "KiB", "MiB", "GiB", "TiB"] as const;

/** A number of bytes as a person reads it: `512 MiB`, `2 GiB`, `1.5 GiB`. */
function bytesText(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
  return `${shown} ${BYTE_UNITS[unit] ?? "bytes"}`;
}

/** A setting's value as the page shows it. */
export function workflowCapabilityValueText(entry: WorkflowCapabilitySetting): string {
  const { value, unit } = entry;
  if (typeof value === "string") return value;
  switch (unit) {
    case "bytes":
      return bytesText(value);
    case "seconds":
      return `${value} s`;
    case "minutes":
      return `${value} min`;
    case "cpus":
      return `${value} CPU`;
    default:
      return value.toLocaleString("en-US");
  }
}

function settingsTable(entries: readonly WorkflowCapabilitySetting[]): string[] {
  return [
    "| Bound | Value | Setting |",
    "| --- | --- | --- |",
    ...entries.map(
      (entry) =>
        `| ${entry.about} | ${workflowCapabilityValueText(entry)} | ${entry.key === undefined ? "fixed" : `\`${entry.key}\``} |`
    )
  ];
}

/**
 * Who a rendering of the page is for: `release` the product docs, with the release's defaults
 * and the packages left to the instance; `instance` the instance's own docs, with its values
 * and without Connections, which depend on the reader; `reader` one reader, Connections too.
 */
export type WorkflowCapabilitiesAudience = "release" | "instance" | "reader";

function connectionLine(connection: WorkflowCapabilityConnection): string {
  const operations = connection.operations.map(
    (operation) =>
      `\`${operation.name}\` (${operation.effect}${operation.effect === "changing" && !operation.enabled ? ", switched off" : ""})`
  );
  const other =
    connection.otherOperations > 0
      ? `; ${connection.otherOperations} more not exposed to \`workflow\``
      : "";
  return `- **${connection.title}** (\`${connection.name}\`, ${connection.connectorType}${connection.enabled ? "" : ", switched off"}): ${operations.length === 0 ? "no operation exposed to `workflow`" : operations.join(", ")}${other}`;
}

/** The page "What a Workflow can do", as Markdown without front matter. */
export function renderWorkflowCapabilitiesPage(
  capabilities: WorkflowCapabilities,
  audience: WorkflowCapabilitiesAudience
): string {
  const { runtime, reach } = capabilities;
  const release = audience === "release";
  const packages = release
    ? [
        "The packages are the runner image's pinned Python distributions. Your instance lists them with their versions. A Workflow declares the ones its code steps need under `packages`; publish refuses any other."
      ]
    : runtime.packageManifest !== "available"
      ? [
          `The runner image's package list could not be read (${runtime.packageManifest}): publish refuses every declared package until the image is fixed.`
        ]
      : [
          "A Workflow declares the packages its code steps need under `packages`; publish refuses any other.",
          "",
          ...runtime.packages.map(({ name, version }) => `- \`${name}\` ${version}`)
        ];
  const connections =
    audience === "reader"
      ? reach.connections.length === 0
        ? ["You may use no Connection."]
        : reach.connections.map(connectionLine)
      : [
          "`workflows.capabilities` names each Connection its reader may use, with the operations exposed to `workflow` and which changing ones an administrator switched on."
        ];
  return [
    release
      ? "What a Workflow can do on this release, with the release's defaults. Each instance answers the same list with its own values as `workflows.capabilities`. Before it writes a Workflow, the Build Agent reads it and answers with one of four: it fits; it fits once an administrator or the operator switches something on, which it names; it belongs in another kind; or it is not a fit yet, with the reason."
      : "What a Workflow can do on this instance. Before it writes a Workflow, the Build Agent reads the same list as `workflows.capabilities`.",
    "",
    "## Runtime",
    "",
    release
      ? "Code steps run where the instance has a sandbox and a command worker."
      : runtime.codeSteps === "available"
        ? "This instance runs code steps."
        : "This instance runs no code steps: it has no sandbox.",
    "",
    ...runtime.languages.map(
      ({ language, command, endings }) =>
        `- ${language}: an entry ending in ${endings.map((ending) => `\`${ending}\``).join(" or ")}, run with \`${command}\``
    ),
    "",
    ...packages,
    "",
    "## Ceilings",
    "",
    "The operator raises a ceiling in release config under its setting. A step that needs more than a ceiling allows fails.",
    "",
    ...settingsTable(capabilities.ceilings),
    "",
    "## Source",
    "",
    "A Workflow's source is its folder: `workflow.yaml` and the files its code steps read.",
    "",
    ...settingsTable(capabilities.source),
    "",
    "## Reach",
    "",
    "An `operation` step calls an operation of a Connection exposed to `workflow`. A changing operation runs only once an administrator switched it on. A code step reaches nothing outside its container.",
    "",
    ...connections,
    ...(release || reach.changingConnectorTypes.length === 0
      ? []
      : [
          "",
          `Connector types with changing operations: ${reach.changingConnectorTypes.map((type) => `\`${type}\``).join(", ")}.`
        ]),
    "",
    "## Not offered",
    "",
    ...capabilities.notOffered.map((entry) => `- ${entry.text}`)
  ].join("\n");
}
