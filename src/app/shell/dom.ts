// Small DOM helper shared by the shell modules (nav chrome, sheets, alerts,
// the bell). Mirrors the shape of a sibling project's `ui.js` `el()` —
// spec string + attrs + children, `on*` attrs as listeners — written fresh
// here, not copied.
//
// Builds with appendChild()/replaceChildren() rather than Element.append():
// this project's tsconfig pulls in @cloudflare/workers-types globally, and
// that package's HTMLRewriter typings declare their own ambient `Element`
// whose `append()` signature shadows lib.dom's. See shell.ts's header note.

export type ElAttrs = Record<string, string | number | boolean | ((event: Event) => void) | undefined | null>;
export type ElChild = Node | string | null | undefined | false;

/**
 * `el("a.sheet-row#foo", { href: "#/x", onClick: fn }, [iconNode, "Label"])`
 * — a class/id spec, an attrs bag (an `on*` key wires a listener; `text`/
 * `html` set content directly), and children appended in order.
 */
export function el(spec: string, attrs: ElAttrs = {}, children: ElChild[] = []): HTMLElement {
  const parts = spec.split(/(?=[.#])/);
  const tag = parts[0] || "div";
  const node = document.createElement(tag);
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i] ?? "";
    if (token[0] === ".") node.classList.add(token.slice(1));
    else if (token[0] === "#") node.id = token.slice(1);
  }

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (value === false && !key.startsWith("aria-")) continue;
    if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (typeof value === "boolean") {
      node.setAttribute(key, key.startsWith("aria-") ? String(value) : "");
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function appendChildren(parent: HTMLElement, ...children: HTMLElement[]): void {
  for (const child of children) parent.appendChild(child);
}

export function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren();
  return node;
}

export function forEachEl<T extends Element>(list: NodeListOf<T>, fn: (item: T) => void): void {
  for (let i = 0; i < list.length; i++) {
    const item = list.item(i);
    if (item) fn(item);
  }
}
