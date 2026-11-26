import esbuild from "esbuild";
import npmConfig from "../esbuild.config.mjs";
import workspaceConfig from "../esbuild.workspace.config.mjs";

await esbuild.build(npmConfig);
await esbuild.build(workspaceConfig);
