/* Resolve extensionless relative imports for `node --test`.
   ────────────────────────────────────────────────────────────────────────
   The application is built as CommonJS (tsconfig: moduleResolution "Node"), so
   every module in src/ imports its neighbours WITHOUT a file extension —
   `import { … } from "../storage/storage-keys"`. That spelling is correct for
   the build and is how the whole codebase is written.

   `node --test` runs the same TypeScript through the ESM loader in strip-only
   mode, and there an extensionless relative specifier does not resolve at all:
   it fails with ERR_MODULE_NOT_FOUND before a single test runs. Until now no
   test imported a src/ module that had relative imports of its own — the pure
   kernels (outcome.ts, matching.ts, piece-edit-lock.ts) are self-contained,
   which is why this never came up. cascade.ts is the first that isn't: it
   imports storage-keys to decide which files a delete may remove.

   The two ways out are rewriting every import in src/ to carry a ".ts"
   extension — which the Nest build does not want — or adding the extension back
   at resolve time, for tests only. This is the second. It is test tooling: it is
   never loaded by the application, and it changes nothing about what ships.

   Deliberately a FALLBACK, not an override: anything Node can already resolve
   (node_modules, explicit extensions, builtins) is left completely alone, so
   this can only turn a hard failure into a success and never silently redirect
   an import that was already working. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Tried in order; the first that exists on disk wins. */
const CANDIDATE_SUFFIXES = [".ts", "/index.ts", ".mjs", ".js"];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Only relative specifiers, and only the "couldn't find it" failure — a
    // module that exists and throws while loading must keep its own error.
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    if (!specifier.startsWith(".") || !context.parentURL) throw err;

    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = new URL(specifier + suffix, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    throw err;
  }
}
