// Bundles the gated post-auth app (section 13.2) into dist/app/, as plain text files the
// Worker imports and streams back verbatim (see wrangler.toml `[[rules]]` and
// src/worker/index.ts's serveGatedBundle). Run via `npm run build:app`, and automatically
// before `dev`/`deploy` — the Worker won't start without these files present.

import { build } from "esbuild";
import { mkdir, writeFile, readFile } from "node:fs/promises";

const OUT_DIR = "dist/app";

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const result = await build({
    entryPoints: ["src/app/shell/main.ts"],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: `${OUT_DIR}/main.js`,
    write: false,
    sourcemap: false,
  });

  const jsOutput = result.outputFiles[0];
  if (!jsOutput) throw new Error("esbuild produced no output for src/app/shell/main.ts");
  await writeFile(`${OUT_DIR}/main.js.txt`, jsOutput.text);

  const css = await readFile("src/app/shell/shell.css", "utf8");
  await writeFile(`${OUT_DIR}/shell.css.txt`, css);

  console.log(`Built ${OUT_DIR}/main.js.txt and ${OUT_DIR}/shell.css.txt`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
