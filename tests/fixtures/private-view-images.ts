/** Inputs shared by the writer's DOM checks and Chromium's connection counters. */
export function privateRowImages(there: string) {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  // An SVG image loads nothing while it is an image. Opened in a tab of its own it is a
  // document, and this link in it works.
  const svg = `<svg xmlns='http://www.w3.org/2000/svg'><a href='${there}/hit?row=secret'><text y='12'>Details</text></a></svg>`;
  const refused = [
    `data:image/svg+xml,${encodeURIComponent(svg)}`,
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    `DATA:IMAGE/SVG+XML,${encodeURIComponent(svg)}`,
    `  data:image/svg+xml,${encodeURIComponent(svg)}  `,
    `\tdata:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    `data:image/png;x=,image/svg+xml,${encodeURIComponent(svg)}`,
    `data:text/html,${encodeURIComponent(`<a href="${there}/hit?row=secret">Details</a>`)}`,
    `data:,${encodeURIComponent(svg)}`,
    "blob:null/3f0e2a52-7f2c-4a43-9d57-0c1f1f5a8b11",
    `${there}/hit?img=1`
  ];
  const kept = [
    `data:image/png;base64,${png}`,
    `DATA:IMAGE/PNG;BASE64,${png}`,
    ` data:image/png;base64,${png} `
  ];
  const image = (source: string, name: string) =>
    `<img class="${name}" alt="${name}" width="1" height="1" src="${source.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`;

  const html = [
    ...refused.map((source) => image(source, "refused")),
    ...kept.map((source) => image(source, "kept"))
  ].join("");
  return { html, refused, kept, png };
}
