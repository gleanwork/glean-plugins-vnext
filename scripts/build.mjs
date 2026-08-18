// Build the plugin's MCP server into a single-file ESM bundle.
//
// Why bundle: Cowork's plugin-install validator rejects zip entries whose
// paths contain `@`, which appears in every scoped npm package's directory
// name (`node_modules/@modelcontextprotocol/...`). Inlining every dep into
// one `dist/index.js` means the shipped tree has no scoped-package paths.
//
// Bundle shape:
//   - platform=node, format=esm so Node can load it with `node dist/index.js`
//     and no `--experimental-*` flags, matching our package.json type:module
//   - bundle=true with packages='bundled' so every import except Node
//     builtins gets inlined
//   - external: the `node:*` builtins (explicit for clarity; esbuild on
//     platform=node treats bare `node:*` as external by default but we pin
//     it so this doesn't regress silently)
//   - no sourcemap or minification — the bundle is checked into git and
//     should stay readable for debugging

import { build } from "esbuild";
import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

// Bake the plugin version into the bundle as a literal.
//
// Why at build time rather than read at runtime: the value is what a remote policy
// uses to decide whether this plugin is outdated, blocked, or unsupported, so it has
// to be the version of the code that is actually running. A manifest read at runtime
// reports only what an editable file next to the bundle claims. CI already verifies
// that `dist/` is in sync with source, so a compiled-in literal cannot drift from the
// manifest unnoticed.
//
// The build FAILS rather than emitting a bundle with a missing or malformed version.
// Baking it in makes this step load-bearing: a silently absent constant would make
// every install report an unknown version and disable any version-dependent
// behaviour fleet-wide, which is a far worse outcome than a red build.
const MANIFEST = "plugins/glean/.claude-plugin/plugin.json";

function pluginVersionFromManifest() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  } catch (err) {
    throw new Error(`build: cannot read ${MANIFEST}: ${err.message}`);
  }
  const version = raw.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `build: ${MANIFEST} must declare a plain x.y.z version, got ${JSON.stringify(version)}. ` +
        `The bundled constant is what the plugin reports about itself, so an absent or ` +
        `malformed value fails the build rather than shipping.`,
    );
  }
  return version;
}

const pluginVersion = pluginVersionFromManifest();

await build({
  entryPoints: ["src/index.ts"],
  outfile: "plugins/glean/dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Substituted into src/version.ts. JSON.stringify so it lands as a quoted literal.
  define: {
    __GLEAN_PLUGIN_VERSION__: JSON.stringify(pluginVersion),
  },
  // Not setting `packages` — esbuild only accepts `"external"` here, which
  // would ship every dep as a runtime lookup (defeating the purpose). The
  // default when `bundle:true` is to inline every import whose specifier
  // isn't in `external`, which is exactly what we want.
  external: nodeBuiltins,
  // Some transitive deps (e.g. `yaml`) ship CJS that does `require("node:*")`
  // at module-eval time. esbuild inlines that CJS under an ESM shim that
  // does NOT provide a `require`, so imports blow up with "Dynamic require
  // of X is not supported". Prepending a `createRequire`-based shim gives
  // the inlined CJS a working `require` for Node builtins.
  banner: {
    js: `import { createRequire as __glean_createRequire } from "node:module";\nconst require = __glean_createRequire(import.meta.url);`,
  },
  minify: false,
  legalComments: "linked",
  logLevel: "info",
  // The SDK and some transitive deps still ship CJS under their "require"
  // export condition. We're emitting ESM and asking esbuild to resolve
  // through each package's "import" condition first.
  conditions: ["import", "node", "default"],
  mainFields: ["module", "main"],
});
