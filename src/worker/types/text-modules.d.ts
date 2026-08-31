// Wildcard ambient module for the built app-bundle text imports in index.ts (see
// wrangler.toml `[[rules]]` and scripts/build-app.mjs). TypeScript resolves this by
// pattern-matching the import specifier, not by reading dist/ off disk, so `tsc --noEmit`
// works even before `npm run build:app` has produced the files.
declare module "*.txt" {
  const content: string;
  export default content;
}
