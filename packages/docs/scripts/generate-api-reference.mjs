// Writes the "API reference" pages from the OpenAPI document of the release, the file the
// api-contract package ships. The pages are build output: they are not committed, and every
// build, dev start and typecheck of the site writes them again.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeApiReference } from "@vivd-catalyst/api-contract";

const require = createRequire(import.meta.url);
const document = JSON.parse(
  readFileSync(require.resolve("@vivd-catalyst/api-contract/openapi.json"), "utf8")
);
const directory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/content/docs/reference/api"
);

// A heading of the schemas page gets its anchor from Starlight: the name in lower case.
const schemaAnchor = (name) => `#${name.toLowerCase()}`;
const reference = describeApiReference(document, {
  schemaHref: (name) => `../schemas/${schemaAnchor(name)}`
});
const { schemas } = describeApiReference(document, { schemaHref: schemaAnchor });

/** One page: front matter, then blocks separated by blank lines. A fragment is one line of HTML. */
function page(file, { title, label = title, description, order }, blocks) {
  const frontMatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    "sidebar:",
    `  label: ${JSON.stringify(label)}`,
    `  order: ${order}`,
    "---"
  ].join("\n");
  writeFileSync(join(directory, file), `${[frontMatter, ...blocks].join("\n\n")}\n`);
}

const slug = (value) => value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");

rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });

page(
  "index.md",
  {
    title: "API reference",
    label: "Overview",
    description: `Every operation of the HTTP API of release ${reference.version}.`,
    order: 0
  },
  [
    `This is the reference of release ${reference.version}, written from the \`openapi.json\` that the package \`@vivd-catalyst/api-contract\` ships. A running instance serves the reference of the operations it runs itself at \`/api/v1/docs\`, and the document behind it at \`/api/v1/openapi.json\`. Both ask for a signed-in person or an access token.`,
    reference.overview
  ]
);
reference.groups.forEach((group, index) => {
  page(
    `${slug(group.tag)}.md`,
    {
      title: group.tag,
      description: `The ${group.tag} operations of release ${reference.version}.`,
      order: index + 1
    },
    group.operations.flatMap((operation) => [`## ${operation.summary}`, operation.html])
  );
});
page(
  "schemas.md",
  {
    title: "Schemas",
    description: `The named schemas of release ${reference.version}.`,
    order: reference.groups.length + 1
  },
  schemas.flatMap((schema) => [`## ${schema.name}`, schema.html])
);

console.log(
  `[docs] wrote the API reference of release ${reference.version}: ${reference.groups.length} groups, ${schemas.length} schemas`
);
