// No @types package exists for this one (unlike turndown itself) — just enough of a shape
// for the one function the notes editor actually calls (editor.ts).
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export function gfm(service: TurndownService): void;
}
