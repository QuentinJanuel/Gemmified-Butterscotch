// Bundles the plugin entry into an ES module a host can load by URL, and writes plugin.json.
//
// Into host/dist/; dist/ is the Emscripten build's output, and `pnpm package` puts both in plugin/.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_MANIFEST_NAME } from "./gems/engine/manifest";
import { manifest } from "./src/plugin";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: { host: path.join(here, "src/plugin.ts") },
  outdir: path.join(here, "dist"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: false,
  // `import(new URL("butterscotch.mjs", import.meta.url))` finds the runner beside the entry;
  // esbuild leaves a dynamic import of a computed URL alone.
  logLevel: "info",
});

// The manifest, generated from the plugin object so the two cannot disagree.
const { version } = JSON.parse(await readFile(path.join(here, "..", "package.json"), "utf8")) as {
  version: string;
};

const document = `${JSON.stringify(manifest(version), null, 2)}\n`;
await writeFile(path.join(here, "dist", PLUGIN_MANIFEST_NAME), document);
console.log(
  `host/build: wrote dist/${PLUGIN_MANIFEST_NAME} for ${manifest(version).id}@${version}`,
);
