// UI icons as inline SVG path data, authored by hand on a 24×24 grid.
// No icon font, no sprite sheet (SPEC constraint 1). Stroke style comes
// from CSS; these are just the geometry.

const svg = (paths: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  /** A radiating voxel: the emissive brush. */
  light: svg(
    '<rect x="9" y="9" width="6" height="6"/>' +
      '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.2 2.2M16.2 16.2l2.2 2.2M18.4 5.6l-2.2 2.2M7.8 16.2l-2.2 2.2"/>'
  ),
  /** A voxel dissolving: erase. */
  erase: svg(
    '<rect x="5" y="5" width="9" height="9"/>' +
      '<path d="M17 14l4 4M21 14l-4 4M14 17.5h-1M17.5 13v1"/>'
  ),
  /** Angle brackets: show me the code. */
  code: svg('<path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/>'),
  /** Tray with a falling file: export. */
  download: svg('<path d="M12 3v11M8 10l4 4 4-4M4 17v3h16v-3"/>'),
} as const;

export type IconName = keyof typeof ICONS;
