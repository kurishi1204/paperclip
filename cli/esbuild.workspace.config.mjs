import { readFileSync } from "node:fs";
import config from "./esbuild.config.mjs";

const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Workspace packages keep their own dependency resolution and published build
// paths. Only the CLI's declared npm dependencies remain external to this bundle.
export default {
  ...config,
  outfile: "dist/workspace.js",
  external: [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    "@paperclipai/*",
  ],
};
