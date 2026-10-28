import { mkdirSync, writeFileSync } from "node:fs";
import { DEFAULT_THEME_INPUTS } from "@work-shape/catalyst-ui/theme";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { isPreviewCaptureWithinBounds } from "@work-shape/catalyst-core";
import type { CaptureOutcome } from "@work-shape/catalyst-preview-capture";

// Explicit opt-in: also a required PR job, on Linux with exactly the production restrictions.
const suite = process.env.CAPTURE_BROWSER_TESTS === "1" ? describe : describe.skip;
const lane = `srv1-${process.pid}`;
const image = process.env.CAPTURE_IMAGE ?? "catalyst-srv1-preview-capture";
const api = `${lane}-api`,
  service = `${lane}-capture`;
const token = "local-capture-fixture-token-00000000";
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 35_000, maxBuffer: 2_000_000 });
const peer = (script: string) => docker("exec", api, "node", "--input-type=module", "-e", script);
const fixture = (html: string) =>
  peer(`await fetch('http://127.0.0.1:4100/fixture',{method:'POST',body:${JSON.stringify(html)}})`);
function capture(extra: Record<string, unknown> = {}): CaptureOutcome {
  const input = {
    themeColors: DEFAULT_THEME_INPUTS.light,
    contentPath: "/app-content/fset_00000000-0000-0000-0000-000000000000/proof.mac/",
    session: "capture:pcap_fixture",
    deadline: Date.now() + 20_000,
    size: "desktop",
    theme: "light",
    locale: "de",
    number: 1,
    ...extra
  };
  return JSON.parse(
    peer(
      `const r=await fetch('http://${service}:4120/capture',{method:'POST',headers:{authorization:'Bearer ${token}','content-type':'application/json'},body:${JSON.stringify(JSON.stringify(input))}});console.log(await r.text());`
    )
  );
}
suite("isolated Linux capture service", () => {
  beforeAll(async () => {
    docker(
      "network",
      "create",
      "--internal",
      "--label",
      "catalyst.worktree=srv1-preview-capture",
      lane
    );
    docker(
      "run",
      "-d",
      "--name",
      api,
      "--network",
      lane,
      "--network-alias",
      "api",
      "--label",
      "catalyst.worktree=srv1-preview-capture",
      "--mount",
      `type=bind,src=${resolve(".capture-fixture.mjs")},dst=/fixture.mjs,readonly`,
      "--mount",
      `type=bind,src=${resolve("packages/server/vendor")},dst=/vendor,readonly`,
      image,
      "node",
      "/fixture.mjs"
    );
    docker(
      "run",
      "-d",
      "--name",
      service,
      "--network",
      lane,
      "--label",
      "catalyst.worktree=srv1-preview-capture",
      "--read-only",
      "--tmpfs",
      "/tmp:size=192m,mode=1777",
      "--shm-size",
      "256m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      `seccomp=${resolve("packages/deployment-kit/docker/preview-capture-seccomp.json")}`,
      "--pids-limit",
      "192",
      "--cpus",
      "1.5",
      "--memory",
      "512m",
      "-e",
      `PREVIEW_CAPTURE_SERVICE_TOKEN=${token}`,
      "-e",
      "PREVIEW_CAPTURE_API_ORIGIN=http://api:4100",
      "-e",
      "PREVIEW_CAPTURE_INTERFACE_ORIGIN=http://interface.invalid",
      "-e",
      "PREVIEW_CAPTURE_CONCURRENCY=1",
      image
    );
    // Poll readiness without retrying a test: a startup refusal ends the fixture immediately.
    for (let n = 0; n < 100; n++) {
      const state = docker("inspect", "-f", "{{.State.Status}}", service).trim();
      if (state !== "running") throw new Error(docker("logs", service));
      try {
        peer(
          `try{const r=await fetch('http://${service}:4120/health');if(!r.ok)process.exit(1)}catch{process.exit(1)}`
        );
        return;
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    throw new Error("Service did not become ready");
  }, 30_000);
  afterAll(() => {
    for (const name of [service, api]) {
      try {
        docker("rm", "-f", name);
      } catch {
        /* setup failed */
      }
    }
    try {
      docker("network", "rm", lane);
    } catch {
      /* setup failed */
    }
  });
  it("proves renderer seccomp and distinct user isolation, with no other credentials or network", () => {
    const log = docker("logs", service);
    const evidence = JSON.parse(
      log
        .trim()
        .split("\n")
        .find((line) => line.includes('"event":"preview_capture_sandbox"')) ?? "{}"
    );
    mkdirSync(".tmp/capture-proof", { recursive: true });
    writeFileSync(".tmp/capture-proof/sandbox.json", JSON.stringify(evidence, null, 2));
    expect(evidence.seccomp).toBe(2);
    expect(evidence.browserUserIsolation).not.toBe(evidence.rendererUserIsolation);
    const [config] = JSON.parse(docker("inspect", service));
    expect(config.Config.Env.join("\n")).not.toMatch(
      /DATABASE_URL|AWS_|AUTH_SECRET|SESSION.*SECRET|OPENAI/
    );
    expect(Object.keys(config.NetworkSettings.Networks)).toEqual([lane]);
    expect(JSON.parse(docker("network", "inspect", lane))[0].Internal).toBe(true);
    expect(
      docker(
        "exec",
        service,
        "node",
        "--input-type=module",
        "-e",
        `for(const url of ['https://example.com','http://postgres:5432','http://object-store:9000']){try{await fetch(url,{signal:AbortSignal.timeout(200)});throw Error('reachable')}catch(e){if(e.message==='reachable')throw e}}`
      )
    ).toBe("");
  });
  it("captures plain HTML and the guard reports a non-empty page", () => {
    fixture("<h1>Plain Page</h1>");
    const result = capture();
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("capture failed");
    expect(isPreviewCaptureWithinBounds(Buffer.from(result.image, "base64"))).toEqual({
      width: 1280,
      height: 800
    });
    expect(result.report).toMatchObject({ settled: true, empty: false });
    mkdirSync(".tmp/capture-proof", { recursive: true });
    writeFileSync(".tmp/capture-proof/desktop.webp", Buffer.from(result.image, "base64"));
  });
  it("captures React, the kit, theme and fonts, with every App call stubbed", () => {
    fixture(
      `<div id="root"></div><link rel="stylesheet" href="/app-runtime/kit/KIT_VERSION/fonts/fonts.css"><link rel="stylesheet" href="/app-runtime/kit/KIT_VERSION/ui.css"><script type="module">import React from '/app-runtime/kit/KIT_VERSION/react.js'; import {createRootRoute} from '/app-runtime/kit/KIT_VERSION/router.js'; import * as kit from '/app-runtime/kit/KIT_VERSION/kit.js'; const routeTree=createRootRoute({component:()=>React.createElement('h1',{style:{fontFamily:'Inter'}},'Kit App')}); await kit.mountApp({routeTree}); const c=await kit.getContext(); if(c.locale!=='de'||c.mode!=='dark') throw Error('Wrong capture context'); kit.actions.call('loadRows',{}).catch(e=>{document.body.dataset.code=e.code});</script>`
    );
    const result = capture({
      size: "phone",
      theme: "dark",
      themeColors: DEFAULT_THEME_INPUTS.dark
    });
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("capture failed");
    expect(Buffer.from(result.image, "base64").length).toBeGreaterThan(1000);
    expect(result.report).toMatchObject({ settled: true, empty: false });
    const served = peer("console.log(await (await fetch('http://127.0.0.1:4100/served')).text())");
    writeFileSync(".tmp/capture-proof/phone-dark.webp", Buffer.from(result.image, "base64"));
    expect(result.calls).toContainEqual({ name: "loadRows", code: "not_available" });
    expect(served).toContain("ui.css");
    expect(served).toContain("react.js");
    expect(served).toContain("kit.js");
    expect(served).toContain("woff2");
  });
  it("blocks published outside hosts and unrelated API paths and omits queries from diagnostics", () => {
    fixture(
      `<h1>Network refusals</h1><script>fetch('https://outside.example/pixel?secret=hidden');fetch('http://interface.invalid/unexpected/users?secret=hidden');</script><img src='https://outside.example/image?secret=hidden'>`
    );
    const result = capture();
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("capture failed");
    expect(result.blocked).toContainEqual({
      method: "GET",
      host: "outside.example",
      path: "/pixel"
    });
    expect(result.blocked).toContainEqual({
      method: "CSP",
      host: "interface.invalid",
      path: "/unexpected/users"
    });
    expect(result.blocked).toContainEqual({
      method: "GET",
      host: "outside.example",
      path: "/image"
    });
    expect(JSON.stringify(result.blocked)).not.toContain("hidden");
    expect(
      peer("console.log(await (await fetch('http://127.0.0.1:4100/served')).text())")
    ).not.toContain("/unexpected/users");
  });
  it("forgets storage, cookies and caches between Apps and prevents downloads", () => {
    fixture(
      `<h1>First</h1><script>localStorage.setItem('secret','first');const a=document.createElement('a');a.href='data:text/plain,download';a.download='capture-leak.txt';a.click();</script>`
    );
    expect(capture().status).toBe("done");
    fixture(
      `<h1>Second</h1><script>if(localStorage.getItem('secret'))throw Error('leaked');</script>`
    );
    const result = capture();
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("capture failed");
    expect(JSON.stringify(result.report)).not.toContain("leaked");
    expect(docker("exec", service, "find", "/tmp", "-name", "capture-leak.txt").trim()).toBe("");
    expect(
      docker(
        "exec",
        service,
        "find",
        "/tmp",
        "-path",
        "*/playwright-artifacts-*/*",
        "-type",
        "f"
      ).trim()
    ).toBe("");
  });
  it.each(["while(true){}", "const held=[];for(;;)held.push(new Uint8Array(1024*1024).fill(1))"])(
    "ends a stuck renderer and the next capture succeeds: %s",
    (script) => {
      fixture(`<script>${script}</script>`);
      const start = Date.now();
      const result = capture();
      expect(result).toMatchObject({ status: "refused", code: "capture_failed" });
      expect(Date.now() - start).toBeLessThan(22_000);
      fixture("<h1>Recovered</h1>");
      expect(capture().status).toBe("done");
    }
  );
  it("refuses startup when Docker blocks the process namespace sandbox", () => {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:mode=1777",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "-e",
        `PREVIEW_CAPTURE_SERVICE_TOKEN=${token}`,
        image
      ],
      { encoding: "utf8", timeout: 15_000 }
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("refused startup");
  });
  it("refuses an actual renderer launched with no sandbox", () => {
    const script = `import {chromium} from 'playwright';import {rendererSandboxEvidence} from './dist/index.js';const b=await chromium.launch({chromiumSandbox:false});try{const page=await b.newPage();await page.goto('data:text/html,probe');const c=await b.newBrowserCDPSession();const {processInfo}=await c.send('SystemInfo.getProcessInfo');try{await rendererSandboxEvidence(processInfo.find(p=>p.type==='browser').id,processInfo.find(p=>p.type==='renderer').id);process.exitCode=1}catch{console.log('refused')}}finally{await b.close()}`;
    expect(docker("exec", service, "node", "--input-type=module", "-e", script).trim()).toBe(
      "refused"
    );
    expect(docker("logs", service)).not.toContain("proof.mac");
  });
  it("refuses a request without the service token", () => {
    expect(
      peer(
        `console.log((await fetch('http://${service}:4120/capture',{method:'POST',body:'{}'})).status)`
      )
    ).toContain("403");
  });
});
