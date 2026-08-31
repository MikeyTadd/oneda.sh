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
 *
 * The tag is a runtime string, so the return type cannot be inferred from
 * it. It defaults to `HTMLElement`; pass the specific interface when a
 * caller needs the element's own API — `el<HTMLSelectElement>("select")`.
 *
 * `T` is deliberately unconstrained. `T extends HTMLElement` would be the
 * natural bound, but @cloudflare/workers-types (global here, for the
 * Worker half of the codebase) declares its own ambient `Element` for
 * HTMLRewriter whose `remove(): Element` merges into lib.dom's — and
 * `HTMLSelectElement.remove()` returns `void`, so under this tsconfig
 * HTMLSelectElement does not satisfy `extends HTMLElement`. Hence the
 * built-as-HTMLElement, cast-at-the-return shape below.
 */
export function el<T = HTMLElement>(spec: string, attrs: ElAttrs = {}, children: ElChild[] = []): T {
  const parts = spec.split(/(?=[.#])/);
  const tag = parts[0] || "div";
  const node: HTMLElement = document.createElement(tag);
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i] ?? "";
    if (token[0] === ".") node.classList.add(token.slice(1));
    else if (token[0] === "#") node.id = token.slice(1);
  }

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (value === false && !key.startsWith("aria-")) continue;
    // `class` ADDS to whatever the spec string already gave the node —
    // never replaces it. A bare setAttribute("class", …) silently drops
    // the classes in the spec, which is how `el("div.nav-row", {class:
    // "on-bar"})` became a node with only `on-bar`: `.nav-row .ico` then
    // matched nothing, the icon inside it lost its width/height rule, and
    // an unsized <svg> in a flex row does not collapse — it takes the
    // replaced-element default and stretches to fill the row.
    if (key === "class") {
      for (const name of String(value).split(/\s+/)) {
        if (name) node.classList.add(name);
      }
    } else if (key === "text") node.textContent = String(value);
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
  return node as T;
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
