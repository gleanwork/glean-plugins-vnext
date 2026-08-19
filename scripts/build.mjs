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
//
// Every host manifest is read, not just one. Reading a single manifest would bake in
// whichever host happened to be picked and silently disagree with the others if they
// ever drifted. scripts/check-version-bump.sh enforces that all three match, but only
// in CI — a local build has to catch it too, since that is where the constant is made.
const MANIFESTS = [
  "plugins/glean/.claude-plugin/plugin.json",
  "plugins/glean/.codex-plugin/plugin.json",
  "plugins/glean/.cursor-plugin/plugin.json",
];

// Same pattern as SEMVER_RE in scripts/check-version-bump.sh, and deliberately stricter
// than \d+: that would accept a non-canonical "01.02.003", which CI then rejects. The
// two checks must agree, or a local build can produce a version CI refuses.
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function pluginVersionFromManifest() {
  const found = MANIFESTS.map((manifest) => {
    let raw;
    try {
      raw = JSON.parse(readFileSync(manifest, "utf-8"));
    } catch (err) {
      throw new Error(`build: cannot read ${manifest}: ${err.message}`);
    }
    const version = raw.version;
    if (typeof version !== "string" || !SEMVER_RE.test(version)) {
      throw new Error(
        `build: ${manifest} must declare a plain x.y.z version, got ${JSON.stringify(version)}. ` +
          `The bundled constant is what the plugin reports about itself, so an absent or ` +
          `malformed value fails the build rather than shipping.`,
      );
    }
    return { manifest, version };
  });

  const versions = [...new Set(found.map((f) => f.version))];
  if (versions.length > 1) {
    throw new Error(
      `build: plugin manifests disagree on the version, so there is no single value to ` +
        `bake in:\n` +
        found.map((f) => `  ${f.version}  ${f.manifest}`).join("\n"),
    );
  }
  return versions[0];
}

const pluginVersion = pluginVersionFromManifest();
const OUTFILE = "plugins/glean/dist/index.js";

await build({
  entryPoints: ["src/index.ts"],
  outfile: OUTFILE,
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

// Assert on the OUTPUT, not just the manifest that fed it.
//
// Validating the manifest proves the value existed; it does not prove the value reached
// the bundle. If the define ever stops applying -- the identifier renamed in
// src/version.ts but not here, or the define key dropped in a merge -- the build still
// succeeds, `dist/` still matches a fresh build so CI's diff check passes, and every
// install silently reports an unknown version with version enforcement off fleet-wide.
// That is the failure this whole approach trades for, so it gets a check rather than a
// comment. CI runs `npm run build`, so this covers CI too, with no separate job.
const bundled = readFileSync(OUTFILE, "utf-8");
if (bundled.includes("__GLEAN_PLUGIN_VERSION__")) {
  throw new Error(
    `build: ${OUTFILE} still contains the __GLEAN_PLUGIN_VERSION__ placeholder, so the ` +
      `esbuild define did not substitute it. The bundle would report an unknown version ` +
      `and disable version-dependent behaviour. Check that the identifier in ` +
      `src/version.ts matches the define key here.`,
  );
}
if (!bundled.includes(JSON.stringify(pluginVersion))) {
  throw new Error(
    `build: ${OUTFILE} does not contain the version literal ${JSON.stringify(pluginVersion)}, ` +
      `so the plugin has no version baked in.`,
  );
}
console.log(`Baked plugin version ${pluginVersion} into ${OUTFILE}`);
