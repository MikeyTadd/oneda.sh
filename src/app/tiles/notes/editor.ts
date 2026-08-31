// A note's editor: a formatted (WYSIWYG-ish) view by default, a raw-markdown "code" view on
// demand, and a toolbar that edits the formatted view directly. Two libraries do the actual
// conversion — marked (markdown -> HTML, for rendering the formatted view and for switching
// back to it from code) and turndown (+turndown-plugin-gfm for tables/strikethrough, HTML ->
// markdown, for saving and for switching into code view) — both only run at a view-toggle or
// a save, never on every keystroke, so normal typing is native contenteditable/textarea
// input with no risk of the conversion fighting the cursor.
//
// The markdown string is what's actually persisted (store.ts) — this module hands the
// current one back on every change via onChange, debounced saving is the caller's job.

import { marked } from "marked";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { appendChildren, el } from "../../shell/dom.js";

marked.setOptions({ breaks: true, gfm: true });

const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
turndown.use(gfm);

export interface NoteEditor {
  /** The current content as markdown, from whichever view is actually active. */
  getMarkdown(): string;
  /** Replaces the content — used once, when a different note is opened. */
  setMarkdown(markdown: string): void;
  focus(): void;
}

export function createNoteEditor(container: HTMLElement, initialMarkdown: string, onChange: () => void): NoteEditor {
  let mode: "formatted" | "code" = "formatted";

  const formatted = el("div.note-body", { contenteditable: "true", "aria-label": "Note content" });
  const code = el<HTMLTextAreaElement>("textarea.note-code", { "aria-label": "Note content (markdown)" });
  code.hidden = true;

  formatted.innerHTML = marked.parse(initialMarkdown || "", { async: false }) as string;
  code.value = initialMarkdown;

  formatted.addEventListener("input", onChange);
  code.addEventListener("input", onChange);

  const toolbar = buildToolbar({
    exec: (command, value) => {
      formatted.focus();
      document.execCommand(command, false, value);
      onChange();
    },
    insertTable: () => {
      insertAtCursor(formatted, tableHtml(3, 3));
      onChange();
    },
    insertLink: () => {
      const url = prompt("Link URL");
      if (!url) return;
      formatted.focus();
      document.execCommand("createLink", false, url);
      onChange();
    },
    toggleCode: () => {
      if (mode === "formatted") {
        code.value = turndown.turndown(formatted.innerHTML);
        formatted.hidden = true;
        code.hidden = false;
        mode = "code";
      } else {
        formatted.innerHTML = marked.parse(code.value, { async: false }) as string;
        code.hidden = true;
        formatted.hidden = false;
        mode = "formatted";
      }
    },
  });

  appendChildren(container, toolbar, formatted, code);

  return {
    getMarkdown(): string {
      return mode === "formatted" ? turndown.turndown(formatted.innerHTML) : code.value;
    },
    setMarkdown(markdown: string): void {
      mode = "formatted";
      formatted.hidden = false;
      code.hidden = true;
      formatted.innerHTML = marked.parse(markdown || "", { async: false }) as string;
      code.value = markdown;
    },
    focus(): void {
      (mode === "formatted" ? formatted : code).focus();
    },
  };
}

interface ToolbarDeps {
  exec(command: string, value?: string): void;
  insertTable(): void;
  insertLink(): void;
  toggleCode(): void;
}

function buildToolbar(deps: ToolbarDeps): HTMLElement {
  const btn = (cls: string, title: string, svgPaths: string, onClick: () => void): HTMLElement => {
    const b = el<HTMLButtonElement>(`button.note-tool.${cls}`, { type: "button", title, "aria-label": title, onClick });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = svgPaths;
    b.appendChild(svg);
    return b;
  };

  const group = (...children: HTMLElement[]): HTMLElement => el("div.note-tool-group", {}, children);

  return el("div.note-toolbar", {}, [
    group(
      btn("bold", "Bold", '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7Zm0 7h7a3.5 3.5 0 0 1 0 7H7Z"/>', () => deps.exec("bold")),
      btn("italic", "Italic", '<path d="M11 5h6M7 19h6M14 5 10 19"/>', () => deps.exec("italic")),
      btn("strike", "Strikethrough", '<path d="M5 12h14M8 7.5c0-1.7 1.8-3 4-3s4 1 4 2.6M8.5 16.5c0 1.8 1.8 3 3.8 3s4-1.1 4-3"/>', () =>
        deps.exec("strikeThrough")
      )
    ),
    group(
      btn("h1", "Heading", '<path d="M4 5v14M12 5v14M4 12h8"/><path d="M16 10l3-1.5V17"/>', () => deps.exec("formatBlock", "H2")),
      btn("h2", "Subheading", '<path d="M4 5v14M11 5v14M4 12h7"/><path d="M14.5 9.5a2.5 2.5 0 0 1 5 0c0 2-4.5 3.5-5 7.5h5"/>', () =>
        deps.exec("formatBlock", "H3")
      ),
      btn("quote", "Quote", '<path d="M7 8.5C5.5 9.5 5 11 5 12.5S6 15 7.5 15 10 13.8 10 12.3 9 9.7 7.5 9.7"/><path d="M15 8.5c-1.5 1-2 2.5-2 4s1 2.5 2.5 2.5S18 13.8 18 12.3s-1-2.6-2.5-2.6"/>', () =>
        deps.exec("formatBlock", "BLOCKQUOTE")
      ),
      btn("code", "Code", '<path d="M9 8 5 12l4 4M15 8l4 4-4 4"/>', () => deps.exec("formatBlock", "PRE"))
    ),
    group(
      btn("ul", "Bullet list", '<circle cx="5.5" cy="7" r="1.2"/><circle cx="5.5" cy="12" r="1.2"/><circle cx="5.5" cy="17" r="1.2"/><path d="M9.5 7h9M9.5 12h9M9.5 17h9"/>', () =>
        deps.exec("insertUnorderedList")
      ),
      btn("ol", "Numbered list", '<path d="M4.5 6.5h1.2V9M4.5 9h1.5M4.7 13.2c0-.7.6-1.2 1.3-1.2s1.3.4 1.3 1c0 .5-.3.8-.9 1.3l-1.5 1.3h2.4M9.5 7h9M9.5 12h9M9.5 17h9"/>', () =>
        deps.exec("insertOrderedList")
      ),
      btn("hr", "Divider", '<path d="M5 12h14"/>', () => deps.exec("insertHorizontalRule"))
    ),
    group(
      btn("link", "Link", '<path d="M9.5 14.5 14.5 9.5"/><path d="M11 7l1-1a3.5 3.5 0 0 1 5 5l-1 1M13 17l-1 1a3.5 3.5 0 0 1-5-5l1-1"/>', () =>
        deps.insertLink()
      ),
      btn("table", "Table", '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 10h16M4 15h16M10.5 5v14"/>', () =>
        deps.insertTable()
      )
    ),
    el<HTMLButtonElement>("button.note-view-toggle", {
      type: "button",
      text: "View code",
      onClick: (event) => {
        deps.toggleCode();
        const target = event.currentTarget as HTMLButtonElement;
        target.textContent = target.textContent === "View code" ? "View formatted" : "View code";
      },
    }),
  ]);
}

function insertAtCursor(host: HTMLElement, html: string): void {
  host.focus();
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !host.contains(selection.anchorNode)) {
    host.insertAdjacentHTML("beforeend", html);
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const fragment = range.createContextualFragment(html);
  const last = fragment.lastChild;
  range.insertNode(fragment);
  if (last) {
    range.setStartAfter(last);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function tableHtml(rows: number, cols: number): string {
  const headerCells = Array.from({ length: cols }, (_, i) => `<th>Column ${i + 1}</th>`).join("");
  const bodyRow = `<tr>${Array.from({ length: cols }, () => `<td>&nbsp;</td>`).join("")}</tr>`;
  const bodyRows = Array.from({ length: rows - 1 }, () => bodyRow).join("");
  return `<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table><p><br></p>`;
}
