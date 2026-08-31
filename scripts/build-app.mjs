// Build step for both halves of the client.
//
//  dist/app/     the gated post-auth bundle (section 13.2), as plain text files the
//                Worker imports and streams back verbatim — see wrangler.toml's
//                `[[rules]]` and src/worker/index.ts's serveGatedBundle.
//  dist/public/  the public pre-auth surface (section 13.1), which is what
//                wrangler.toml's [assets] binding serves.
//
// Both are minified, which also strips every comment. That is the point for the
// public half: section 13.3 puts the goal as not handing an anonymous visitor a
// tour of the design, and a commented lock screen does exactly that — the source
// keeps its comments, the thing served does not.
//
// Run via `npm run build:app`, and automatically before `dev`/`deploy`.

import { build, transform } from "esbuild";
import { mkdir, writeFile, readFile, readdir, copyFile, rm } from "node:fs/promises";
import { join, extname, dirname } from "node:path";

const APP_OUT = "dist/app";
const PUBLIC_SRC = "public";
const PUBLIC_OUT = "dist/public";

/** Files whose bytes are the asset — nothing to strip, just carry them over. */
const COPY_AS_IS = new Set([".woff2", ".png", ".jpg", ".svg", ".ico", ".webmanifest", ".txt"]);

async function buildGatedBundle() {
  await mkdir(APP_OUT, { recursive: true });

  const result = await build({
    entryPoints: ["src/app/shell/main.ts"],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: `${APP_OUT}/main.js`,
    minify: true,
    write: false,
    sourcemap: false,
  });
  const js = result.outputFiles[0];
  if (!js) throw new Error("esbuild produced no output for src/app/shell/main.ts");
  await writeFile(`${APP_OUT}/main.js.txt`, js.text);

  const css = await readFile("src/app/shell/shell.css", "utf8");
  const minCss = await transform(css, { loader: "css", minify: true });
  await writeFile(`${APP_OUT}/shell.css.txt`, minCss.code);

  return { js: js.text.length, css: minCss.code.length, cssRaw: css.length };
}

/** Comments and the whitespace between tags. Deliberately conservative: it leaves
 * text content alone, so nothing the reader sees can shift. */
function stripHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n\s*\n+/g, "\n")
    .replace(/^\s+$/gm, "")
    .trim();
}

async function buildPublic() {
  await rm(PUBLIC_OUT, { recursive: true, force: true });
  let files = 0;

  async function walk(dir) {
    for (const entry of await readdir(join(PUBLIC_SRC, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(rel);
        continue;
      }
      const src = join(PUBLIC_SRC, rel);
      const out = join(PUBLIC_OUT, rel);
      await mkdir(dirname(out), { recursive: true });
      const ext = extname(entry.name);

      if (COPY_AS_IS.has(ext)) {
        await copyFile(src, out);
      } else if (ext === ".js") {
        // transform, not build: auth.js is a module and sw.js is a classic worker
        // script, and neither should be rewrapped in another format.
        const { code } = await transform(await readFile(src, "utf8"), { loader: "js", minify: true });
        await writeFile(out, code);
      } else if (ext === ".json") {
        await writeFile(out, JSON.stringify(JSON.parse(await readFile(src, "utf8"))));
      } else if (ext === ".html") {
        const html = await readFile(src, "utf8");
        // The lock screen's CSS lives in an inline <style>; minify it in place so
        // its comments go the same way as everything else.
        let outHtml = stripHtml(html);
        const style = outHtml.match(/(<style[^>]*>)([\s\S]*?)(<\/style>)/);
        if (style) {
          const { code } = await transform(style[2], { loader: "css", minify: true });
          outHtml = outHtml.replace(style[0], `${style[1]}${code}${style[3]}`);
        }
        await writeFile(out, outHtml);
      } else {
        await copyFile(src, out);
      }
      files++;
    }
  }

  await walk(".");
  return files;
}

async function main() {
  const app = await buildGatedBundle();
  const files = await buildPublic();
  const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
  console.log(`Built ${APP_OUT}: main.js.txt ${kb(app.js)}, shell.css.txt ${kb(app.css)} (from ${kb(app.cssRaw)})`);
  console.log(`Built ${PUBLIC_OUT}: ${files} files, comments stripped`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
