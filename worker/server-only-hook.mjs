// Spec 0013 AC-22. The worker renders React Email, which needs
// react-dom/server, and the react-server condition swaps that for a stub that
// throws. So `npm run worker` runs without the condition and loads this hook
// with --import instead: it maps the `server-only` marker to the package's
// own empty.js (what the react-server condition would pick) and changes
// nothing else.
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

// empty.js is not in the package's exports (only the condition reaches it),
// so it is found beside the default entry.
export const SERVER_ONLY_EMPTY = pathToFileURL(
  join(dirname(require.resolve("server-only")), "empty.js"),
).href;

export function resolveServerOnly(specifier, context, nextResolve) {
  if (specifier === "server-only")
    return { url: SERVER_ONLY_EMPTY, format: "commonjs", shortCircuit: true };
  return nextResolve(specifier, context);
}

registerHooks({ resolve: resolveServerOnly });
