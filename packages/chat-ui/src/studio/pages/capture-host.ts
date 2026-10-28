import { createPageBridge } from "./bridge-host";
import type { AppBridgeContext, AppBridgeGuardReport } from "@work-shape/catalyst-api-client";

// Bundled for preview-capture. There is no API client, person, token or grant in this host.
declare global {
  interface Window {
    captureInput: { address: string; session: string; context: AppBridgeContext };
    captureReport?: AppBridgeGuardReport;
    captureCalls: { name: string; code: string }[];
  }
}
const input = window.captureInput;
const frame = document.createElement("iframe");
frame.style.cssText = "width:100%;height:100vh;border:0;display:block";
window.captureCalls = [];
const unavailable = {
  ok: false as const,
  error: { code: "not_available", message: "This capture is without data." }
};
const bridge = createPageBridge({
  frame: () => frame.contentWindow,
  session: input.session,
  context: () => input.context,
  onNavigate() {},
  onResize(height) {
    frame.style.height = `${Math.min(1600, Math.max(1, height))}px`;
  },
  calls: () => ({
    can: async () => ({}),
    async writeStorage() {
      throw new Error("not_available");
    },
    async run(call) {
      if (window.captureCalls.length < 20)
        window.captureCalls.push({ name: call.name.slice(0, 160), code: "not_available" });
      return unavailable;
    },
    workflowRun: async () => unavailable
  }),
  onReport(report) {
    window.captureReport = report;
  }
});
window.addEventListener("message", (event) => bridge.receive(event));
frame.src = input.address;
document.body.append(frame);
