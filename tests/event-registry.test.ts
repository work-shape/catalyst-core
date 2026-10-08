import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EVENTS,
  type AuditEventName,
  type PlatformEventDefinition,
  type PlatformEventEmitter,
  type PlatformEventName
} from "@vivd-catalyst/core";

type Callable = ts.FunctionDeclaration | ts.MethodDeclaration;
type EventArgument = { index: number; path: string[] };

// Follow only AuditRecorder.record / AuditEventStore.appendAuditEvent inputs.
// Discover wrappers from parameter forwarding, including forwarding through wrappers.
function emittedNames(sources: readonly string[]): Set<string> {
  const files = sources.map((source, index) =>
    ts.createSourceFile(`source-${index}.ts`, source, ts.ScriptTarget.Latest, true)
  );
  const calls: ts.CallExpression[] = [];
  const callables = new Map<string, Callable>();
  const variables: ts.VariableDeclaration[] = [];
  const wrappers = new Map<string, EventArgument[]>();
  const names = new Set<string>();

  function owner(node: ts.Node): Callable | undefined {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) return parent;
    }
    return undefined;
  }
  function className(node: ts.Node): string | undefined {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isClassDeclaration(parent)) return parent.name?.text;
    }
    return undefined;
  }
  function callableKey(node: Callable): string | undefined {
    if (!node.name || !ts.isIdentifier(node.name)) return undefined;
    return ts.isMethodDeclaration(node) ? `${className(node)}.${node.name.text}` : node.name.text;
  }
  function callKey(call: ts.CallExpression): string | undefined {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      return `${className(call)}.${callee.name.text}`;
    }
    return undefined;
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isVariableDeclaration(node)) variables.push(node);
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const key = callableKey(node);
      if (key && node.body) callables.set(key, node);
    }
    ts.forEachChild(node, visit);
  }
  files.forEach(visit);

  // Resolve literal alternatives, local constants, and helper return objects only
  // when reached from an audit argument. Unrelated type properties are never scanned.
  function valuesAt(
    expression: ts.Expression,
    path: string[],
    seen = new Set<ts.Node>()
  ): ts.Expression[] {
    if (seen.has(expression)) return [];
    const nextSeen = new Set(seen).add(expression);
    if (ts.isParenthesizedExpression(expression))
      return valuesAt(expression.expression, path, nextSeen);
    if (ts.isConditionalExpression(expression)) {
      return [expression.whenTrue, expression.whenFalse].flatMap((branch) =>
        valuesAt(branch, path, nextSeen)
      );
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const resolved = valuesAt(expression.expression, [expression.name.text, ...path], nextSeen);
      return resolved.length ? resolved : path.length ? [] : [expression];
    }
    if (ts.isIdentifier(expression)) {
      const declaration = variables.findLast(
        (variable) =>
          ts.isIdentifier(variable.name) &&
          variable.name.text === expression.text &&
          variable.getSourceFile() === expression.getSourceFile() &&
          owner(variable) === owner(expression) &&
          variable.pos < expression.pos
      );
      if (declaration?.initializer) return valuesAt(declaration.initializer, path, nextSeen);
    }
    if (ts.isCallExpression(expression)) {
      const key = callKey(expression);
      const declaration = key ? callables.get(key) : undefined;
      const returned: ts.Expression[] = [];
      function findReturns(node: ts.Node): void {
        if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression);
        if (
          node !== declaration &&
          (ts.isFunctionDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isArrowFunction(node))
        )
          return;
        ts.forEachChild(node, findReturns);
      }
      if (declaration?.body) findReturns(declaration.body);
      return returned.flatMap((value) => valuesAt(value, path, nextSeen));
    }
    if (!path.length) return [expression];
    if (!ts.isObjectLiteralExpression(expression)) return [];
    const [key, ...rest] = path;
    return expression.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
        return [];
      if (
        (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name)) ||
        property.name.text !== key
      )
        return [];
      return valuesAt(
        ts.isPropertyAssignment(property) ? property.initializer : property.name,
        rest,
        nextSeen
      );
    });
  }

  function eventArguments(call: ts.CallExpression): EventArgument[] {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = callee.expression;
      const receiverName = ts.isIdentifier(receiver)
        ? receiver.text
        : ts.isPropertyAccessExpression(receiver)
          ? receiver.name.text
          : undefined;
      if (callee.name.text === "record" && receiverName === "auditRecorder")
        return [{ index: 0, path: ["type"] }];
      if (callee.name.text === "appendAuditEvent") return [{ index: 0, path: ["type"] }];
    }
    if (ts.isIdentifier(callee) && callee.text === "appendAuditEvent")
      return [{ index: 0, path: ["type"] }];
    const key = callKey(call);
    return key ? (wrappers.get(key) ?? []) : [];
  }
  function eventValues(call: ts.CallExpression): ts.Expression[] {
    return eventArguments(call).flatMap(({ index, path }) => {
      const argument = call.arguments[index];
      return argument ? valuesAt(argument, path) : [];
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      const declaration = owner(call);
      const key = declaration ? callableKey(declaration) : undefined;
      if (!declaration || !key) continue;
      for (const value of eventValues(call)) {
        let root = value;
        const path: string[] = [];
        while (ts.isPropertyAccessExpression(root)) {
          path.unshift(root.name.text);
          root = root.expression;
        }
        if (!ts.isIdentifier(root)) continue;
        const parameterName = root.text;
        const index = declaration.parameters.findIndex(
          (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === parameterName
        );
        if (index < 0) continue;
        const arguments_ = wrappers.get(key) ?? [];
        if (
          arguments_.some(
            (argument) => argument.index === index && argument.path.join(".") === path.join(".")
          )
        )
          continue;
        wrappers.set(key, [...arguments_, { index, path }]);
        changed = true;
      }
    }
  }
  for (const call of calls) {
    for (const value of eventValues(call)) {
      if (ts.isStringLiteralLike(value)) names.add(value.text);
    }
  }
  return names;
}

function registryDifferences(emitted: ReadonlySet<string>, registered: readonly string[]) {
  return {
    missing: [...emitted].filter((name) => !registered.includes(name)).sort(),
    unused: registered.filter((name) => !emitted.has(name)).sort()
  };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

describe("event registry", () => {
  const platformPackages = fileURLToPath(new URL("../packages/", import.meta.url));
  const capabilityPackages = fileURLToPath(
    new URL("../../capabilities/packages/", import.meta.url)
  );
  const hasCapabilities = existsSync(capabilityPackages);

  function packageSources(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const src = resolve(root, entry.name, "src");
      if (!entry.isDirectory() || !existsSync(src)) return [];
      return sourceFiles(src).map((path) => readFileSync(path, "utf8"));
    });
  }

  it("registers every emitted platform audit name", () => {
    const names = emittedNames(packageSources(platformPackages));
    expect(registryDifferences(names, Object.keys(EVENTS)).missing).toEqual([]);
  });

  it.skipIf(!hasCapabilities)(
    hasCapabilities
      ? "registers exactly the audit names emitted across platform and capabilities"
      : "capabilities completeness skipped: sibling capabilities/packages repository is absent",
    () => {
      const names = emittedNames([
        ...packageSources(platformPackages),
        ...packageSources(capabilityPackages)
      ]);
      expect(registryDifferences(names, Object.keys(EVENTS))).toEqual({ missing: [], unused: [] });
    }
  );

  const wrapperFixture = `
    function authorizeGovernanceAction(input) {
      return input.options.auditRecorder.record({ type: input.auditType });
    }
    class Workflow {
      recordMutation(user, context, type) {
        return this.options.auditRecorder.record({ type });
      }
      authorize(user, context, auditType) {
        return authorizeGovernanceAction({ auditType });
      }
      run() {
        this.recordMutation(user, context, "subject.updated");
        this.authorize(user, context, "subject.authorized");
        this.options.auditRecorder?.record({ type: "subject.created", metadata: { type: "console.nested" } });
      }
    }
  `;

  it("follows recorder, store, and wrapper arguments while excluding console and unrelated types", () => {
    const names = emittedNames([
      wrapperFixture,
      `
      store.appendAuditEvent({ type: "subject.stored" });
      appendAuditEvent({ type: "subject.appended" });
      authorizeGovernanceAction({ auditType: "subject.viewed" });
      console.warn({ type: "model_context_projection.file_unavailable" });
      console.warn({ type: "model_context_projection.artifact_unavailable" });
      console.warn({ type: "model_context_projection.bounded_tool_output" });
      console.warn({ type: "document_preprocessing.memory_worker_failure" });
      const payload = { type: "agent_runtime.run_failed" };
      console.error(JSON.stringify(payload));
      telemetry.record({ type: "subject.telemetry" });
      recorder.record({ type: "subject.unrelated" });
      const unrelated = { auditType: "subject.unused", type: "subject.unused" };
      class Other { run() { this.recordMutation(user, context, "subject.unrelated_wrapper"); } }
    `
    ]);
    expect([...names].sort()).toEqual([
      "subject.appended",
      "subject.authorized",
      "subject.created",
      "subject.stored",
      "subject.updated",
      "subject.viewed"
    ]);
  });

  it("detects an emitted audit name missing from the registry without a sibling repo", () => {
    const names = emittedNames([wrapperFixture]);
    expect(registryDifferences(names, ["subject.created", "subject.updated"]).missing).toEqual([
      "subject.authorized"
    ]);
  });

  it("detects a registered legacy name emitted nowhere, including console-only names", () => {
    const names = emittedNames([
      `
      auditRecorder.record({ type: "subject.created" });
      console.warn({ type: "subject.console_only" });
    `
    ]);
    expect(
      registryDifferences(names, ["subject.created", "subject.unused", "subject.console_only"])
        .unused
    ).toEqual(["subject.console_only", "subject.unused"]);
  });

  it("follows computed alternatives and helper results only when passed to audit", () => {
    const names = emittedNames([
      `
      function terminalType(command) {
        if (command.done) return { type: "subject.completed" };
        return { type: "subject.failed" };
      }
      function recordLifecycle(input) {
        return input.auditRecorder?.record({ type: input.type });
      }
      function run(command) {
        const terminal = terminalType(command);
        const type = command.started ? "subject.started" : "subject.queued";
        recordLifecycle({ type });
        recordLifecycle({ type: terminal.type });
      }
      function consoleType() { return { type: "subject.console_only" }; }
      console.warn(consoleType());
    `
    ]);
    expect([...names].sort()).toEqual([
      "subject.completed",
      "subject.failed",
      "subject.queued",
      "subject.started"
    ]);
  });

  it("retains every current audit name unchanged as legacy and audited", () => {
    for (const [name, definition] of Object.entries(EVENTS)) {
      expect(definition.name).toBe(name);
      expect(definition.legacy).toBe(true);
      expect(definition.audited).toBe(true);
      expect(definition.phases).toEqual(["after"]);
      expect(definition.subject).not.toBe("");
    }
    expectTypeOf<(typeof EVENTS)[PlatformEventName]>().toExtend<PlatformEventDefinition>();
    expectTypeOf<AuditEventName>().toEqualTypeOf<PlatformEventName>();
    expectTypeOf<PlatformEventEmitter["emit"]>().parameter(0).toEqualTypeOf<PlatformEventName>();
  });
});
