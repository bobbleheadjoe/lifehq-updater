import esbuild from "esbuild";
import builtins from "builtin-modules";
const mode = process.argv[2];
if (mode === "test") {
  // Bundle the pure engine for node-based tests.
  await esbuild.build({ entryPoints: ["src/engine.ts"], bundle: true, format: "esm", platform: "node", outfile: "test/engine.mjs", logLevel: "info" });
} else {
  await esbuild.build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["obsidian", "electron", ...builtins],
    format: "cjs",
    target: "es2020",
    logLevel: "info",
    sourcemap: mode === "production" ? false : "inline",
    treeShaking: true,
    minify: mode === "production",
    outfile: "main.js",
  });
}
