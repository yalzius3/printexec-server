/* Install ./ts-extension-resolver.mjs as a module-resolution hook.
   Loaded via `node --import ./scripts/register-ts-extension-resolver.mjs`,
   which both `npm test` and `npm run test:integration` do. See the header of
   ts-extension-resolver.mjs for why it is needed and why it is a fallback. */
import { register } from "node:module";

// import.meta.url as the parent so the hook resolves relative to THIS file
// regardless of the working directory the runner was launched from (and so the
// Windows path is turned into a proper file:// URL for us).
register("./ts-extension-resolver.mjs", import.meta.url);
