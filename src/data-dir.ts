// The NAMED import, deliberately, matching every call site this replaced. Tests that
// redirect the home directory mock `node:os` as `{...actual, homedir}`, which overrides the
// named export and leaves the default export pointing at the real module -- so
// `import os from "node:os"` here would quietly read the developer's real ~/.glean while
// the test believed it was using a temp directory.
import { homedir } from "node:os";
import path from "node:path";

/**
 * Where the plugin keeps its state on disk.
 *
 * There are two answers, not one, and the difference is load-bearing enough that both
 * live here rather than being spelled out at each call site.
 *
 * `start.mjs` reads whatever data directory the host provides and re-exports it as
 * PLUGIN_DATA_DIR, so server code has a single variable to consult. Hooks get no such
 * favour: they are separate processes the host spawns directly, so they never see
 * PLUGIN_DATA_DIR and can only look at the host's own variable. Anything the server and a
 * hook must agree on therefore has to key off the host variable on BOTH sides -- which is
 * why picking the wrong one of these two functions produces a file written in one place
 * and looked for in another, with no error anywhere.
 *
 * Under `start.mjs` the two resolve to the same directory, which is exactly what makes the
 * mistake survive testing: they diverge only when PLUGIN_DATA_DIR is set and
 * CLAUDE_PLUGIN_DATA is not.
 */
const DEFAULT_DIR = ".glean";

/**
 * For state only this process touches: tokens, the URL config, the policy cache, the log.
 *
 * Prefers PLUGIN_DATA_DIR because that is the variable `start.mjs` normalizes the host's
 * answer into, so this follows a managed data directory wherever the host puts it.
 */
export function serverDataDir(): string {
  return process.env.PLUGIN_DATA_DIR || path.join(homedir(), DEFAULT_DIR);
}

/**
 * For state shared with a hook: the HITL permission-mode marker, the inventory capture.
 *
 * Deliberately does NOT consult PLUGIN_DATA_DIR, even though it usually holds the same
 * value. A hook cannot see that variable, so preferring it here would mean the server
 * looking somewhere the hook could never have written whenever the two differ. The
 * duplicate of this expression in plugins/glean/hooks/*.mjs is the other half of the same
 * agreement and cannot be shared as code -- those files are unbundled ESM the host runs
 * directly, while this one is compiled into dist/. tests/inventory-cache.test.ts pins the
 * two together by running the real hook and reading the result back through this module.
 */
export function hostSharedDataDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(homedir(), DEFAULT_DIR);
}
