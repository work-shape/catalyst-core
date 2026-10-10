import { VIEW_SHELL, VIEW_SHELL_MESSAGES } from "@vivd-catalyst/api-contract";

// The shell: the document every generated view is framed in. A view is a `srcdoc` frame, and a
// content policy cannot stop a document from navigating its own frame to another host, with
// data in the address. The policy of the document that holds the frame can: under
// `frame-src 'none'` the browser refuses the navigation before it asks for anything. The
// interface cannot be that document, because it also runs on other sites as the widget, under
// whatever policy the site has. So the instance serves this one, with the policy as a header.
//
// A `srcdoc` frame takes over the policies of the document that holds it. Everything in the
// header therefore also binds the view, and the header can allow no less than a view needs:
// its script sources are the upper bound of every view, and each view's own policy, which
// names its inline scripts by hash, narrows them. This is why the shell's script is a file and
// the header names no hash: a hash here would refuse every inline script of every view.

/**
 * The policy of the shell document and, by inheritance, the outer bound of every view.
 * `sandbox` gives the shell no origin, whoever frames it and however: it never runs as the
 * instance. `allowedScriptSrc` is `views.allowedScriptSrc` of the instance config.
 */
export function viewShellContentPolicy(allowedScriptSrc: readonly string[]): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    // 'self' is the shell's script and the view runtime. Inline scripts and eval are a view's:
    // its own policy holds inline scripts to the hashed ones, and the Tailwind compiler evaluates.
    `script-src ${["'self'", "'unsafe-inline'", "'unsafe-eval'", ...allowedScriptSrc].join(" ")}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    // The reason the shell exists. It refuses every address a view could move its frame to,
    // the instance's own included. The view itself is `srcdoc` and is not an address.
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
}

// One shell holds one view. The frame of the view is created here and nowhere else: without
// `allow-same-origin` it has no origin, and it runs scripts only when the interface says this
// view may. Messages are taken from two windows alone. The window that frames the shell hands
// over the document; its origin cannot be checked, because the widget runs on any site, and
// need not be: the shell holds nothing, and whoever frames it can only show itself a document
// inside the policy above. The view's window reports height and refused scripts, and only
// those two shapes are passed on.
const SHELL_SCRIPT = `(function () {
  "use strict";
  var messages = ${JSON.stringify(VIEW_SHELL_MESSAGES)};
  var host = window.parent;
  var view = null;
  if (host === window) {
    return;
  }
  function showView(data) {
    view = document.createElement("iframe");
    view.setAttribute("sandbox", data.scripts === true ? "allow-scripts" : "");
    if (data.scripts === true) {
      view.setAttribute("scrolling", "no");
    }
    view.title = typeof data.title === "string" ? data.title : "";
    view.addEventListener("load", function () {
      host.postMessage({ type: messages.loaded }, "*");
    });
    view.srcdoc = data.document;
    document.body.appendChild(view);
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") {
      return;
    }
    if (event.source === host) {
      if (!view && data.type === messages.document && typeof data.document === "string") {
        showView(data);
      }
      return;
    }
    if (!view || event.source !== view.contentWindow || event.origin !== "null") {
      return;
    }
    if (data.type === messages.blocked) {
      host.postMessage({ type: messages.blocked }, "*");
    } else if (
      data.type === messages.height &&
      typeof data.height === "number" &&
      isFinite(data.height) &&
      data.height > 0
    ) {
      host.postMessage({ type: messages.height, height: data.height }, "*");
    }
  });
  host.postMessage({ type: messages.ready }, "*");
})();
`;

const SHELL_DOCUMENT = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>View</title>
<style>
html, body { height: 100%; margin: 0; overflow: hidden; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<script src="${VIEW_SHELL.scriptFile}"></script>
</body>
</html>
`;

export interface ViewShellFile {
  body: string;
  contentType: string;
  /** What `Sec-Fetch-Dest` says of a request for this file when a browser sends the header. */
  fetchDestination: string;
}

/** The files of the shell: version, then file name. */
export const VIEW_SHELL_FILES: ReadonlyMap<string, ReadonlyMap<string, ViewShellFile>> = new Map([
  [
    VIEW_SHELL.version,
    new Map([
      [
        VIEW_SHELL.documentFile,
        {
          body: SHELL_DOCUMENT,
          contentType: "text/html; charset=utf-8",
          fetchDestination: "iframe"
        }
      ],
      [
        VIEW_SHELL.scriptFile,
        {
          body: SHELL_SCRIPT,
          contentType: "text/javascript; charset=utf-8",
          fetchDestination: "script"
        }
      ]
    ])
  ]
]);
