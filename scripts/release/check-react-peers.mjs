// A packed UI package must resolve hooks and the renderer from the host's runtime.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkReactPeers(consumer) {
  const host = createRequire(resolve(consumer, "package.json"));
  for (const name of ["@work-shape/catalyst-chat-ui", "@work-shape/catalyst-ui"]) {
    const ui = createRequire(realpathSync(resolve(consumer, "node_modules", name, "package.json")));
    for (const runtime of ["react", "react/jsx-runtime", "react-dom", "react-dom/client"]) {
      if (ui.resolve(runtime) !== host.resolve(runtime)) {
        throw new Error(`${name} resolves a different ${runtime} from its host`);
      }
    }
  }
  console.log("UI peers resolve the host React and React DOM");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkReactPeers(process.argv[2]);
}
