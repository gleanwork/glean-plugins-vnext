// The plugin's own version, as a build-time constant.
//
// `scripts/build.mjs` substitutes `__GLEAN_PLUGIN_VERSION__` with a literal read from
// the plugin manifest, and fails the build if that value is missing or is not a plain
// `x.y.z`. Baking it in is what makes the value trustworthy: the shipped bundle cannot
// disagree with the release it was built from, and editing a manifest after install
// does not change what the plugin reports. CI already verifies that `dist/` is in sync
// with source, so the constant cannot drift from the manifest unnoticed.
//
// There is deliberately no runtime fallback to reading a manifest or an environment
// variable. Both are user-editable, so falling back would turn "the constant is
// missing" into "here is a version the user can edit". That matters because this value
// is what a remote policy would use to decide whether a plugin is outdated, blocked,
// or unsupported: a fallback would be a downgrade path for anyone able to make the
// constant unreadable. `unknown` is the honest answer, and callers are expected to skip
// version-dependent behaviour rather than guess.
declare const __GLEAN_PLUGIN_VERSION__: string | undefined;

/** How the version was obtained, and therefore how far it can be trusted. */
export type VersionSource = "build" | "unknown";

export interface ResolvedVersion {
  version: string;
  source: VersionSource;
}

// `typeof` on an undeclared identifier is safe in JS and yields "undefined", so a dev
// run through `tsx` -- where esbuild never applied the define -- resolves to `unknown`
// instead of throwing a ReferenceError.
const BUILD_VERSION: string | undefined =
  typeof __GLEAN_PLUGIN_VERSION__ === "string"
    ? __GLEAN_PLUGIN_VERSION__
    : undefined;

/**
 * The version this build reports, plus whether it is trustworthy.
 *
 * `source: "build"` in every bundle produced by scripts/build.mjs, which fails rather
 * than emitting one without the constant, and now also asserts the substitution landed
 * in the output.
 *
 * `source: "unknown"` is therefore not a broken-bundle case — it is the path taken when
 * the code runs without having been bundled at all: `npm run dev` and any other tsx
 * entry, where esbuild never applied the define. Reachable in development, unreachable
 * in anything shipped. Callers skip version-dependent behaviour rather than treat the
 * placeholder as real, which is what makes a dev run enforce no version policy.
 */
export function pluginVersion(): ResolvedVersion {
  if (BUILD_VERSION) return { version: BUILD_VERSION, source: "build" };
  // A placeholder rather than an empty string, so callers never have to handle a
  // missing value; `source` is what signals that the number means nothing.
  return { version: "0.0.0", source: "unknown" };
}

/** Convenience for the MCP `serverInfo` / `clientInfo` version field. */
export function pluginVersionString(): string {
  return pluginVersion().version;
}
