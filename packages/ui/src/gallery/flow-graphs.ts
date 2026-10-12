import type {
  FlowGraph,
  FlowGraphEdge,
  FlowGraphGroup,
  FlowGraphNode,
  FlowStatus
} from "../flow/flow-types";
import type { GalleryText } from "./text";

type Statuses = Partial<Record<string, FlowStatus>>;

/** The linear sample: a trigger, a read, a loop of three steps, an agent and a result. */
export function linearGraph(text: GalleryText, run?: "running" | "failed" | "done"): FlowGraph {
  const status: Statuses =
    run === "running"
      ? {
          trigger: "done",
          load: "done",
          loop: "running",
          bookings: "running",
          check: "running",
          save: "running"
        }
      : run === "failed"
        ? {
            trigger: "done",
            load: "failed",
            loop: "skipped",
            bookings: "skipped",
            check: "skipped",
            save: "skipped",
            agent: "skipped",
            result: "skipped"
          }
        : run === "done"
          ? {
              trigger: "done",
              load: "done",
              loop: "done",
              bookings: "done",
              check: "done",
              save: "done",
              agent: "done",
              result: "done"
            }
          : {};
  const ran = run !== undefined;
  const nodes: FlowGraphNode[] = [
    {
      id: "trigger",
      kind: "step",
      icon: "schedule",
      eyebrow: text.flowKindStart,
      title: ran ? text.flowTriggerRun : text.flowTriggerTitle,
      summary: ran ? undefined : text.flowTriggerSummary,
      footer: ran ? text.flowTriggerRunFooter : undefined,
      status: status.trigger
    },
    {
      id: "load",
      kind: "step",
      icon: "database",
      eyebrow: text.flowKindRead,
      title: text.flowLoadTitle,
      summary: text.flowLoadSummary,
      chip: { label: text.flowChipBookings, icon: "connection" },
      footer:
        status.load === "failed"
          ? text.flowLoadFailure
          : status.load === "done"
            ? text.flowLoadFooter
            : undefined,
      meta:
        status.load === "failed"
          ? text.flowDurationLong
          : status.load === "done"
            ? text.flowDurationShort
            : undefined,
      status: status.load
    },
    {
      id: "bookings",
      parentId: "loop",
      kind: "step",
      icon: "database",
      eyebrow: text.flowKindRead,
      title: text.flowBookingsTitle,
      summary: text.flowBookingsSummary,
      chip: { label: text.flowChipBookings, icon: "connection" },
      footer: run === "running" ? text.flowBookingsFooter : undefined,
      status: status.bookings
    },
    {
      id: "check",
      parentId: "loop",
      kind: "step",
      icon: "code",
      eyebrow: text.flowKindScript,
      title: text.flowCheckTitle,
      summary: text.flowCheckSummary,
      footer: run === "running" ? text.flowCheckFooter : undefined,
      status: status.check
    },
    {
      id: "save",
      parentId: "loop",
      kind: "step",
      icon: "database",
      eyebrow: text.flowKindWrite,
      title: text.flowSaveTitle,
      summary: text.flowSaveSummary,
      chip: { label: text.flowChipFindings, icon: "database" },
      footer: run === "running" ? text.flowSaveFooter : undefined,
      status: status.save
    },
    {
      id: "agent",
      kind: "step",
      icon: "agent",
      accent: true,
      eyebrow: text.flowKindAgent,
      title: text.flowAgentTitle,
      summary: text.flowAgentSummary,
      status: status.agent
    },
    {
      id: "result",
      kind: "step",
      icon: "result",
      eyebrow: text.flowKindResult,
      title: text.flowResultTitle,
      status: status.result
    }
  ];
  const groups: FlowGraphGroup[] = [
    {
      id: "loop",
      kind: "loop",
      icon: "repeat",
      eyebrow: text.flowKindLoop,
      title: text.flowLoopTitle,
      summary: ran ? undefined : text.flowLoopSummary,
      status: status.loop,
      ...(run === "running"
        ? {
            counts: { total: 600, done: 209, failed: 3, running: 8 },
            countsLabel: text.flowLoopCounts,
            note: text.flowLoopNote,
            action: { label: text.flowLoopAction }
          }
        : run === "done"
          ? { counts: { total: 600, done: 600 }, countsLabel: text.flowLoopDone }
          : {})
    }
  ];
  const edges: FlowGraphEdge[] = [
    { source: "trigger", target: "load" },
    { source: "load", target: "loop" },
    { source: "bookings", target: "check" },
    { source: "check", target: "save" },
    { source: "loop", target: "agent" },
    { source: "agent", target: "result" }
  ];
  return { nodes, groups, edges };
}

/** The large sample: a condition with two exits, a parallel block, a loop and a subflow. */
export function largeGraph(text: GalleryText, waiting = false): FlowGraph {
  const done: FlowStatus | undefined = waiting ? "done" : undefined;
  const step = (
    id: string,
    icon: string,
    eyebrow: string,
    title: string,
    rest: Partial<FlowGraphNode> = {}
  ): FlowGraphNode => ({ id, kind: "step", icon, eyebrow, title, status: done, ...rest });
  return {
    nodes: [
      step("trigger", "schedule", text.flowKindStart, text.flowTriggerShort),
      step("load", "database", text.flowKindRead, text.flowLoadTitle),
      step("bookings", "database", text.flowKindRead, text.flowBookingsTitle, { parentId: "loop" }),
      step("check", "code", text.flowKindScript, text.flowCheckTitle, { parentId: "loop" }),
      step("save", "database", text.flowKindWrite, text.flowSaveTitle, { parentId: "loop" }),
      step("condition", "branch", text.flowKindCondition, text.flowConditionTitle, {
        kind: "condition",
        exits: [
          { id: "yes", label: text.flowExitYes },
          { id: "otherwise", label: text.flowExitOtherwise }
        ]
      }),
      step("agent", "agent", text.flowKindAgent, text.flowAgentTitle, {
        parentId: "parallel",
        accent: true
      }),
      step("dashboard", "database", text.flowKindWrite, text.flowDashboardTitle, {
        parentId: "parallel"
      }),
      step("approval", "approval", text.flowKindApproval, text.flowApprovalTitle, {
        status: waiting ? "waiting" : undefined,
        footer: waiting ? text.flowApprovalFooter : undefined
      }),
      step("notify", "subflow", text.flowKindSubflow, text.flowSubflowTitle, {
        kind: "subflow",
        action: { label: text.flowOpen },
        status: undefined
      }),
      step("result", "result", text.flowKindResult, text.flowResultShort, { status: undefined })
    ],
    groups: [
      {
        id: "loop",
        kind: "loop",
        icon: "repeat",
        eyebrow: text.flowKindLoop,
        title: text.flowLoopTitle,
        status: done,
        defaultCollapsed: waiting
      },
      {
        id: "parallel",
        kind: "parallel",
        icon: "branch",
        eyebrow: text.flowKindParallel,
        title: text.flowParallelTitle,
        status: done
      }
    ],
    edges: [
      { source: "trigger", target: "load" },
      { source: "load", target: "loop" },
      { source: "bookings", target: "check" },
      { source: "check", target: "save" },
      { source: "loop", target: "condition" },
      { source: "condition", sourceExit: "yes", target: "parallel" },
      { source: "parallel", target: "approval" },
      { source: "approval", target: "notify" },
      { source: "notify", target: "result" },
      {
        source: "condition",
        sourceExit: "otherwise",
        target: "result",
        state: waiting ? "skipped" : undefined
      }
    ]
  };
}
