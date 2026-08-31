// Shell icon set. Kept as inline stroke-path fragments (24×24 viewBox,
// currentColor stroke) rather than an icon font or a bundled sprite sheet —
// there is no bundler here (docs/DESIGN.md's "no dependency beyond what a
// tile itself needs" spirit), so a handful of paths defined in TS is the
// zero-dependency option.
//
// A tile's manifest `icon` (../tiles/types.ts) is documented as "tabler
// icon name or custom SVG" — this module honours both: a name looked up
// here, or a raw `<svg>…</svg>` string passed straight through untouched.
// Only oneda's own tile code ever supplies this value (never remote/user
// content), so passing it through is safe.

const RAW: Record<string, string> = {
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/>',
  more: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  notes: '<path d="M6 3.5h7l5 5V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5Z"/><path d="M13 3.5V8a.5.5 0 0 0 .5.5H18M9 13h6M9 16.5h6"/>',
  messenger: '<path d="M3.5 6.5a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4.5 4V17.5h-0a1 1 0 0 1-1-1Z"/>',
  gallery: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18.5l5.5-6 4 4.2 2.5-3 4 5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3"/>',
  news: '<path d="M3.5 6.5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v12H5.5a2 2 0 0 1-2-2Z"/><path d="M16.5 9.5H19a1 1 0 0 1 1 1v6a2 2 0 0 1-2 2h-1.5"/><rect x="6" y="8.5" width="4.5" height="3.5" rx=".5"/><path d="M12.5 9.5h2M6 14.5h8.5M6 16.5h8.5"/>',
  pet: '<circle cx="7" cy="7.5" r="2"/><circle cx="17" cy="7.5" r="2"/><circle cx="4.5" cy="13" r="1.8"/><circle cx="19.5" cy="13" r="1.8"/><path d="M12 13c-3.3 0-5.5 2.2-5.5 4.6 0 1.6 1.3 2.9 3 2.9 1 0 1.7-.4 2.5-.4s1.5.4 2.5.4c1.7 0 3-1.3 3-2.9 0-2.4-2.2-4.6-5.5-4.6Z"/>',
  bell: '<path d="M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5M4.5 16.5h15M10 19.5a2 2 0 0 0 4 0"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9.5 21v-6h5v6"/>',
  device: '<rect x="4.5" y="3.5" width="15" height="15" rx="2"/><path d="M9 20.5h6"/>',
  play: '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5l6 3.5-6 3.5Z"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3.5a6.5 6.5 0 0 0-3.5 12c.6.4 1 1.1 1 1.9V18h5v-.6c0-.8.4-1.5 1-1.9a6.5 6.5 0 0 0-3.5-12Z"/>',
  camera: '<path d="M4 8.5a1 1 0 0 1 1-1h2.3l1-1.7h7.4l1 1.7H19a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/><circle cx="12" cy="13" r="3.4"/>',
  wallet: '<rect x="3.5" y="6.5" width="17" height="12" rx="2"/><path d="M15 12.5h3.5v2.5H15a1.5 1.5 0 0 1 0-3Z"/><path d="M3.5 9.5h17"/>',
  tile: '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/>',
};

export const ICONS: Record<string, string> = RAW;

export function iconSvg(pathsOrRawSvg: string, cls = "ico"): string {
  const trimmed = pathsOrRawSvg.trim();
  if (trimmed.startsWith("<svg")) return trimmed;
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${trimmed}</svg>`;
}

/** oneda's brand mark — a teal squircle tile with a horizontal dash and a
 * status-pulse dot (README.md, matching public/shell/index.html's inline
 * CSS mark before a JS shell existed to render it as SVG). */
export const MARK_SVG = `
<svg class="mark" viewBox="0 0 40 40" aria-hidden="true">
  <rect class="mark-tile" x="0" y="0" width="40" height="40" rx="11"/>
  <rect class="mark-dash" x="10" y="18.5" width="16" height="3" rx="1.5"/>
  <circle class="mark-dot" cx="29" cy="10" r="3.2"/>
</svg>`.trim();
