#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

const deploymentRoot = resolvePath(args.deploymentDir ?? process.env.LIVE_AGENT_E2E_DEPLOYMENT_DIR);
const apiBaseUrl = (
  args.apiUrl ??
  process.env.LIVE_AGENT_E2E_API_URL ??
  "http://127.0.0.1:4101"
).replace(/\/$/u, "");
const origin = args.origin ?? process.env.LIVE_AGENT_E2E_ORIGIN;
const outputRoot = resolvePath(
  args.outputDir ??
    process.env.LIVE_AGENT_E2E_OUTPUT_DIR ??
    resolve(platformRoot, ".tmp/live-agent-artifact-e2e", timestamp())
);
const scenarios = [
  {
    id: "word",
    locale: "de",
    prompt: "erstelle mir eine Word - \u00fcberrasch mich!",
    title: "Live E2E Word Surprise",
    skill: "documents",
    extension: ".docx",
    renderHints: ["docx_render", "libreoffice", "soffice"],
    inspectHints: ["docx_inspect"],
    helperCreateCommand: "docx_create"
  },
  {
    id: "excel",
    locale: "en",
    prompt: "make me a surprise Excel file",
    title: "Live E2E Excel Surprise",
    skill: "spreadsheets",
    extension: ".xlsx",
    renderHints: ["xlsx_render", "libreoffice", "soffice"],
    inspectHints: ["xlsx_inspect", "xlsx_scan_errors", "xlsx_recalc"],
    helperCreateCommand: "xlsx_create"
  },
  {
    id: "presentation",
    locale: "en",
    prompt: "make me a small presentation, surprise me",
    title: "Live E2E Presentation Surprise",
    skill: "presentations",
    extension: ".pptx",
    renderHints: ["pptx_render", "libreoffice", "soffice"],
    inspectHints: ["pptx_inspect", "pptx_layouts"],
    helperCreateCommand: "pptx_create"
  },
  {
    id: "pdf",
    locale: "en",
    prompt: "create a simple PDF report",
    title: "Live E2E PDF Report",
    skill: "pdf",
    extension: ".pdf",
    renderHints: ["pdf_render_pages", "pdftoppm"],
    inspectHints: ["pdf_inspect", "pdfplumber"],
    helperCreateCommand: "pdf_create"
  }
];
const composeProjectName =
  args.composeProject ??
  process.env.LIVE_AGENT_E2E_COMPOSE_PROJECT ??
  "catalyst-live-agent-artifact-e2e";
const managedCompose = flag(args.manageCompose, process.env.LIVE_AGENT_E2E_MANAGE_COMPOSE, true);
const keepStack = flag(args.keepStack, process.env.LIVE_AGENT_E2E_KEEP_STACK, false);
const buildRunner = flag(args.buildRunner, process.env.LIVE_AGENT_E2E_BUILD_RUNNER, true);
const autoApprove = flag(args.autoApprove, process.env.LIVE_AGENT_E2E_AUTO_APPROVE, true);
const seedAuth = flag(args.seedAuth, process.env.LIVE_AGENT_E2E_SEED_AUTH, managedCompose);
const runTimeoutMs = Number(
  args.runTimeoutMs ?? process.env.LIVE_AGENT_E2E_RUN_TIMEOUT_MS ?? 10 * 60 * 1000
);
const userEmail = args.userEmail ?? process.env.LIVE_AGENT_E2E_USER_EMAIL;
const userPassword = args.userPassword ?? process.env.LIVE_AGENT_E2E_USER_PASSWORD;
const buildRunnerCommand = splitShellWords(
  args.buildRunnerCommand ??
    process.env.LIVE_AGENT_E2E_BUILD_RUNNER_COMMAND ??
    "corepack pnpm@10.29.3 run dev:runner"
);
const seedAuthCommand = splitShellWords(
  args.seedAuthCommand ??
    process.env.LIVE_AGENT_E2E_SEED_AUTH_COMMAND ??
    "corepack pnpm@10.29.3 run seed:auth"
);
const composeServices = splitCsv(
  args.composeServices ??
    process.env.LIVE_AGENT_E2E_COMPOSE_SERVICES ??
    "postgres,s3mock,api,workspace-command-worker,artifact-preview-worker"
);
const selectedScenarios = selectScenarios(args.scenarios ?? process.env.LIVE_AGENT_E2E_SCENARIOS);

const commandEnv = {
  ...process.env,
  COMPOSE_PROJECT_NAME: composeProjectName,
  WORKSPACE_COMMAND_HOST_ROOT:
    process.env.WORKSPACE_COMMAND_HOST_ROOT ??
    `/tmp/vivd-catalyst-${composeProjectName}-execution-workspaces`
};

let cookieHeader = "";
const runReports = [];

if (process.env.LIVE_AGENT_E2E !== "1") {
  console.error(
    [
      "Refusing to run live model E2E without LIVE_AGENT_E2E=1.",
      "This command starts local services and may call the configured model provider.",
      "Use --deployment-dir to point at a client/deployment checkout.",
      "",
      "Example:",
      "  LIVE_AGENT_E2E=1 LIVE_AGENT_E2E_DEPLOYMENT_DIR=../deployment.<customer> \\",
      "    LIVE_AGENT_E2E_USER_EMAIL=user@example.test \\",
      "    LIVE_AGENT_E2E_USER_PASSWORD=... \\",
      "    pnpm test:e2e:live-agent-artifacts"
    ].join("\n")
  );
  process.exit(2);
}

if (!deploymentRoot) {
  throw new Error("Missing --deployment-dir or LIVE_AGENT_E2E_DEPLOYMENT_DIR");
}
if (!userEmail || !userPassword) {
  throw new Error("Missing LIVE_AGENT_E2E_USER_EMAIL or LIVE_AGENT_E2E_USER_PASSWORD");
}
if (selectedScenarios.length === 0) {
  throw new Error(
    `No scenarios selected. Valid ids: ${scenarios.map((scenario) => scenario.id).join(", ")}`
  );
}

try {
  await mkdir(outputRoot, { recursive: true });
  await prepareStack();
  cookieHeader = await signIn();

  for (const scenario of selectedScenarios) {
    console.log(`\n[e2e] scenario ${scenario.id}`);
    const report = await runScenario(scenario);
    runReports.push(report);
    await writeJson(resolve(outputRoot, `${scenario.id}.json`), report);
    printScenarioSummary(report);
  }

  const summary = {
    ok: runReports.every((report) => report.ok),
    apiBaseUrl,
    composeProjectName,
    deploymentRoot,
    selectedScenarios: selectedScenarios.map((scenario) => scenario.id),
    reports: runReports.map(summarizeReport)
  };
  await writeJson(resolve(outputRoot, "summary.json"), summary);

  if (!summary.ok) {
    throw new Error(`Live agent artifact E2E failed. Report: ${outputRoot}`);
  }
  console.log(`\n[e2e] live agent artifact E2E passed. Report: ${outputRoot}`);
} finally {
  if (managedCompose && !keepStack) {
    await runStep("stop Compose stack", ["docker", "compose", "down", "-v", "--remove-orphans"], {
      allowFailure: true
    });
  } else if (keepStack) {
    console.log(`[e2e] keeping Compose stack '${composeProjectName}'`);
  }
}

async function prepareStack() {
  if (!managedCompose) {
    console.log("[e2e] using an existing stack because manage-compose is disabled");
    await waitForHealth();
    if (seedAuth) {
      await runStep("seed standalone auth users", seedAuthCommand);
    }
    return;
  }

  if (buildRunner) {
    await runStep("build runner image", buildRunnerCommand);
  }
  await runStep("start Compose stack", [
    "docker",
    "compose",
    "up",
    "-d",
    "--build",
    ...composeServices
  ]);
  await waitForHealth();
  if (seedAuth) {
    await runStep("seed standalone auth users", seedAuthCommand);
  }
}

async function signIn() {
  const response = await fetch(`${apiBaseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin, referer: `${origin}/` } : {})
    },
    body: JSON.stringify({
      email: userEmail,
      password: userPassword
    })
  });
  if (!response.ok) {
    throw new Error(`Sign-in failed with HTTP ${response.status}: ${await response.text()}`);
  }
  const cookies = getSetCookieHeaders(response.headers).map((cookie) => cookie.split(";")[0]);
  if (cookies.length === 0) {
    throw new Error("Sign-in succeeded but no session cookie was returned");
  }
  return cookies.join("; ");
}

async function runScenario(scenario) {
  const started = await requestJson("/api/v1/conversations/runs", {
    method: "POST",
    body: {
      idempotencyKey: `live-${scenario.id}-${globalThis.crypto.randomUUID()}`,
      agentName: "application_assistant",
      locale: scenario.locale,
      conversation: { title: scenario.title },
      message: { text: scenario.prompt }
    }
  });

  const events = await observeRun(started.eventsUrl, {
    conversationId: started.conversation.id,
    runId: started.run.id
  });
  const messages = await requestList(`/api/v1/conversations/${started.conversation.id}/messages`);
  const thread = await requestJson(`/api/v1/conversations/${started.conversation.id}/thread`, {
    method: "GET"
  });
  const toolCalls = buildToolTrace(events);
  const analysis = analyzeScenario(scenario, events, toolCalls);

  return {
    ok: analysis.failures.length === 0,
    scenario: scenario.id,
    prompt: scenario.prompt,
    conversationId: started.conversation.id,
    runId: started.run.id,
    terminalStatus: analysis.terminalStatus,
    failures: analysis.failures,
    warnings: analysis.warnings,
    metrics: analysis.metrics,
    toolCalls: sanitize(toolCalls),
    assistantMessages: sanitize(readAssistantMessages(messages)),
    finalThread: sanitize(thread)
  };
}

async function observeRun(eventsUrl, input) {
  const events = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runTimeoutMs);
  try {
    const response = await fetch(eventsUrl, {
      headers: { cookie: cookieHeader },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`SSE observe failed with HTTP ${response.status}: ${await response.text()}`);
    }
    if (!response.body) {
      throw new Error("SSE observe did not return a response body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseEvent(chunk);
        if (!event) continue;
        events.push(event);
        if (
          event.payload.type === "tool_decision_requested" &&
          event.payload.mode === "confirm" &&
          autoApprove &&
          event.payload.operationRunId
        ) {
          await requestJson(`/api/v1/operations/runs/${event.payload.operationRunId}/decision`, {
            method: "POST",
            body: { decision: "confirm" }
          });
        }
        if (["run_completed", "run_cancelled", "run_failed"].includes(event.payload.type)) {
          return events;
        }
      }
    }
    return events;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Timed out after ${runTimeoutMs}ms while observing run ${input.runId}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function analyzeScenario(scenario, events, toolCalls) {
  const terminal = events.findLast((event) =>
    ["run_completed", "run_cancelled", "run_failed"].includes(event.payload.type)
  );
  const terminalStatus = terminal?.payload.type ?? "stream_ended_without_terminal_event";
  const failures = [];
  const warnings = [];
  const commands = toolCalls
    .filter((tool) => tool.name === "workspace.exec")
    .map((tool) => readStringProperty(tool.input, "command"))
    .filter(Boolean);
  const joinedCommands = commands.join("\n--- command ---\n");
  const readSkillNames = toolCalls
    .filter((tool) => tool.name === "read_skill")
    .map((tool) => readStringProperty(tool.input, "name"));
  const previewCalls = toolCalls.filter((tool) => tool.name === "workspace.preview_images");
  const promotionCalls = toolCalls.filter((tool) => tool.name === "workspace.promote_artifact");
  const failedTools = toolCalls.filter((tool) => tool.status === "failed");

  if (terminalStatus !== "run_completed") {
    failures.push(`Run did not complete: ${terminalStatus}`);
    if (terminal?.payload.error?.message) {
      failures.push(`Run error: ${terminal.payload.error.message}`);
    }
  }
  if (!readSkillNames.includes(scenario.skill)) {
    failures.push(`Expected read_skill for '${scenario.skill}'`);
  }
  if (commands.length === 0) {
    failures.push("Expected at least one workspace.exec Bash command");
  }
  if (!containsAny(joinedCommands, ["scripts/", "/workspace/scripts/"])) {
    failures.push("Expected script-first workflow under /workspace/scripts");
  }
  if (!containsAny(joinedCommands, ["artifacts/", "/workspace/artifacts/"])) {
    failures.push("Expected final artifact under /workspace/artifacts");
  }
  if (!containsAny(joinedCommands, ["previews/", "/workspace/previews/"])) {
    failures.push("Expected rendered preview files under /workspace/previews");
  }
  if (!containsAny(joinedCommands, scenario.renderHints)) {
    failures.push(`Expected render step using one of: ${scenario.renderHints.join(", ")}`);
  }
  if (!containsAny(joinedCommands, scenario.inspectHints)) {
    warnings.push(`No explicit inspect/check command matched: ${scenario.inspectHints.join(", ")}`);
  }
  if (containsAny(joinedCommands, ["artifact_runtime_info"])) {
    failures.push("artifact_runtime_info was used in the normal path");
  }
  if (containsAny(joinedCommands, [scenario.helperCreateCommand])) {
    failures.push(`${scenario.helperCreateCommand} was used as normal creative creation`);
  }
  if (previewCalls.length === 0) {
    failures.push("Expected workspace.preview_images before final response");
  } else if (!previewCalls.some((tool) => readToolResultStatus(tool) === "ready")) {
    failures.push("workspace.preview_images did not report status ready");
  }
  if (promotionCalls.length === 0) {
    failures.push("Expected workspace.promote_artifact for the final artifact");
  } else if (
    !promotionCalls.some((tool) =>
      JSON.stringify(tool.input ?? {})
        .toLowerCase()
        .includes(scenario.extension)
    )
  ) {
    warnings.push(`Promotion call did not visibly reference a ${scenario.extension} path`);
  }
  if (failedTools.length > 0) {
    failures.push(`Tool failures observed: ${failedTools.map((tool) => tool.name).join(", ")}`);
  }

  return {
    terminalStatus,
    failures,
    warnings,
    metrics: {
      toolCallCount: toolCalls.length,
      workspaceExecCount: commands.length,
      readSkillNames,
      previewCallCount: previewCalls.length,
      promotionCallCount: promotionCalls.length,
      failedToolCount: failedTools.length
    }
  };
}

function buildToolTrace(events) {
  const toolCalls = new Map();
  for (const event of events) {
    const payload = event.payload;
    if (!payload.toolCallId || !payload.toolName) continue;
    if (payload.type === "tool_call_started") {
      toolCalls.set(payload.toolCallId, {
        id: payload.toolCallId,
        name: payload.toolName,
        input: payload.input,
        status: "started"
      });
      continue;
    }
    if (payload.type === "tool_decision_requested") {
      toolCalls.set(payload.toolCallId, {
        ...toolCalls.get(payload.toolCallId),
        id: payload.toolCallId,
        name: payload.toolName,
        input: payload.inputPreview ?? toolCalls.get(payload.toolCallId)?.input,
        status: "decision_requested"
      });
      continue;
    }
    if (payload.type === "tool_call_completed" || payload.type === "tool_call_failed") {
      toolCalls.set(payload.toolCallId, {
        ...toolCalls.get(payload.toolCallId),
        id: payload.toolCallId,
        name: payload.toolName,
        input: toolCalls.get(payload.toolCallId)?.input,
        status: payload.type === "tool_call_completed" ? "completed" : "failed",
        result: payload.result,
        modelOutput: payload.modelOutput
      });
    }
  }
  return [...toolCalls.values()];
}

async function requestList(path) {
  const items = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const page = await requestJson(`${path}?${query}`, { method: "GET" });
    if (
      !Array.isArray(page.items) ||
      (page.nextCursor !== undefined && typeof page.nextCursor !== "string")
    ) {
      throw new Error(`Invalid list response for ${path}`);
    }
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function requestJson(path, input) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: input.method,
    headers: {
      cookie: cookieHeader,
      ...(input.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${input.method} ${path}: ${await response.text()}`);
  }
  return response.json();
}

async function waitForHealth() {
  const deadline = Date.now() + 180_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBaseUrl}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(2_000);
  }
  throw new Error(`API did not become healthy at ${apiBaseUrl}/health: ${lastError}`);
}

async function runStep(label, commandAndArgs, options = {}) {
  const [command, ...stepArgs] = commandAndArgs;
  if (!command) throw new Error(`Empty command for step '${label}'`);
  console.log(`\n[e2e] ${label}`);
  console.log(`$ ${[command, ...stepArgs].join(" ")}`);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, stepArgs, {
      cwd: deploymentRoot,
      env: commandEnv,
      stdio: "inherit"
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0 || options.allowFailure) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${label} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function parseSseEvent(chunk) {
  const dataLines = chunk
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (dataLines.length === 0) return undefined;
  return JSON.parse(dataLines.join("\n"));
}

function readAssistantMessages(messages) {
  return messages
    .filter((message) => message && typeof message === "object" && message.role === "assistant")
    .map((message) => ({
      text: typeof message.text === "string" ? message.text : "",
      metadata: message.metadata
    }));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function printScenarioSummary(report) {
  console.log(`${report.ok ? "ok" : "failed"} - ${report.scenario}`);
  for (const failure of report.failures) console.log(`  failure: ${failure}`);
  for (const warning of report.warnings) console.log(`  warning: ${warning}`);
}

function summarizeReport(report) {
  return {
    ok: report.ok,
    scenario: report.scenario,
    prompt: report.prompt,
    terminalStatus: report.terminalStatus,
    failures: report.failures,
    warnings: report.warnings,
    metrics: report.metrics,
    reportFile: `${report.scenario}.json`
  };
}

function getSetCookieHeaders(headers) {
  const getSetCookie = headers.getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(headers);
  const header = headers.get("set-cookie");
  return header ? [header] : [];
}

function readStringProperty(value, key) {
  if (!value || typeof value !== "object" || !(key in value)) return "";
  const raw = value[key];
  return typeof raw === "string" ? raw : "";
}

function readToolResultStatus(tool) {
  return (
    readStringProperty(tool.result?.output, "status") ||
    readStringProperty(tool.result?.auditSummary?.metadata, "status") ||
    readStringProperty(tool.result, "status")
  );
}

function containsAny(value, needles) {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

function sanitize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncate(redactString(value));
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitize(entry);
    }
    return output;
  }
  return String(value);
}

function isSensitiveKey(key) {
  return /(authorization|cookie|credential|password|secret|session|token|api[_-]?key|objectkey|workspaceid)/iu.test(
    key
  );
}

function redactString(value) {
  return value
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replaceAll(/sk-[A-Za-z0-9._-]+/gu, "sk-[redacted]")
    .replaceAll(/execution-workspaces\/[A-Za-z0-9._~/%-]+/gu, "execution-workspaces/[redacted]");
}

function truncate(value) {
  const max = 4_000;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
}

function flag(argValue, envValue, defaultValue) {
  if (typeof argValue === "boolean") return argValue;
  if (typeof envValue === "string") return !["0", "false", "no"].includes(envValue.toLowerCase());
  return defaultValue;
}

function splitCsv(value) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function splitShellWords(value) {
  const words = [];
  let current = "";
  let quote = "";
  for (const char of value.trim()) {
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function selectScenarios(value) {
  const selected = new Set(splitCsv(value ?? scenarios.map((scenario) => scenario.id).join(",")));
  return scenarios.filter((scenario) => selected.has(scenario.id));
}

function resolvePath(value) {
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function timestamp() {
  return new Date().toISOString().replaceAll(/[:.]/gu, "-");
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--deployment-dir":
        parsed.deploymentDir = requireArg(argv, ++index, arg);
        break;
      case "--api-url":
        parsed.apiUrl = requireArg(argv, ++index, arg);
        break;
      case "--origin":
        parsed.origin = requireArg(argv, ++index, arg);
        break;
      case "--output-dir":
        parsed.outputDir = requireArg(argv, ++index, arg);
        break;
      case "--compose-project":
        parsed.composeProject = requireArg(argv, ++index, arg);
        break;
      case "--compose-services":
        parsed.composeServices = requireArg(argv, ++index, arg);
        break;
      case "--scenarios":
        parsed.scenarios = requireArg(argv, ++index, arg);
        break;
      case "--user-email":
        parsed.userEmail = requireArg(argv, ++index, arg);
        break;
      case "--user-password":
        parsed.userPassword = requireArg(argv, ++index, arg);
        break;
      case "--run-timeout-ms":
        parsed.runTimeoutMs = requireArg(argv, ++index, arg);
        break;
      case "--build-runner-command":
        parsed.buildRunnerCommand = requireArg(argv, ++index, arg);
        break;
      case "--seed-auth-command":
        parsed.seedAuthCommand = requireArg(argv, ++index, arg);
        break;
      case "--manage-compose":
        parsed.manageCompose = true;
        break;
      case "--no-manage-compose":
        parsed.manageCompose = false;
        break;
      case "--keep-stack":
        parsed.keepStack = true;
        break;
      case "--no-build-runner":
        parsed.buildRunner = false;
        break;
      case "--no-auto-approve":
        parsed.autoApprove = false;
        break;
      case "--seed-auth":
        parsed.seedAuth = true;
        break;
      case "--no-seed-auth":
        parsed.seedAuth = false;
        break;
      default:
        throw new Error(`Unknown argument '${arg}'`);
    }
  }
  return parsed;
}

function requireArg(argv, index, flagName) {
  const value = argv[index];
  if (!value) throw new Error(`Missing value for ${flagName}`);
  return value;
}

function printUsage() {
  console.log(`Usage: LIVE_AGENT_E2E=1 node scripts/run-live-agent-artifact-e2e.mjs --deployment-dir ../deployment.<customer> [options]

Runs a real local API/model/workspace-worker artifact workflow over HTTP. This is a
manual or release smoke, not a normal unit test.

Required:
  LIVE_AGENT_E2E=1
  --deployment-dir <path> or LIVE_AGENT_E2E_DEPLOYMENT_DIR
  --user-email <email> / LIVE_AGENT_E2E_USER_EMAIL
  --user-password <password> / LIVE_AGENT_E2E_USER_PASSWORD

Useful options:
  --api-url <url>                 API base URL, default http://127.0.0.1:4101
  --origin <url>                  Origin header for auth, e.g. http://127.0.0.1:5174
  --scenarios word,excel,presentation,pdf
  --no-manage-compose             Use an already running stack
  --no-build-runner               Skip the runner build step
  --keep-stack                    Do not shut down a managed stack
  --output-dir <path>             Report directory
`);
}
