import { containerFullHeight } from './elements.js';

// Below this zoom, a fit-to-screen view of more than a handful of containers is mostly
// unreadable anyway - compact mode trades CPU/RAM bars and metric text for just enough to answer
// "what is this and is it OK". Set high so only native-size-or-closer viewing keeps full metrics.
export const COMPACT_ZOOM_THRESHOLD = 1;
const COMPACT_HEIGHT = 34;

// Small "what type of node is this" glyphs for tree mode's pills - real inline SVG, reused two
// ways: a data URI for CY_STYLE's background-image (live canvas + PNG export), and inlined <g>
// markup by svgExport.js's svgPillIcon (no canvas to reference). Shared 0-12 coordinate space.
export const PROJ_ICON_SVG =
  '<path d="M6 1.2 11 3.6 6 6 1 3.6Z" fill="none" stroke="#2d5fa8" stroke-width="1" stroke-linejoin="round"/>' +
  '<path d="M1.5 6 6 8.2 10.5 6" fill="none" stroke="#2d5fa8" stroke-width="1" stroke-linejoin="round"/>' +
  '<path d="M1.5 8.4 6 10.6 10.5 8.4" fill="none" stroke="#2d5fa8" stroke-width="1" stroke-linejoin="round"/>';
export const NET_ICON_SVG =
  '<circle cx="6" cy="2" r="1.3" fill="#4f8cff"/><circle cx="2" cy="9.5" r="1.3" fill="#4f8cff"/><circle cx="10" cy="9.5" r="1.3" fill="#4f8cff"/>' +
  '<path d="M6 3.3 2 8.3M6 3.3 10 8.3" stroke="#4f8cff" stroke-width="1"/>';
export const MOUNT_BIND_ICON_SVG =
  '<path d="M1.5 3.3c0-.7.6-1.3 1.3-1.3h2l1 1h3.4c.7 0 1.3.6 1.3 1.3v4.4c0 .7-.6 1.3-1.3 1.3H2.8c-.7 0-1.3-.6-1.3-1.3Z" fill="none" stroke="#d29922" stroke-width="1" stroke-linejoin="round"/>';
export const MOUNT_VOLUME_ICON_SVG =
  '<ellipse cx="6" cy="2.6" rx="4.3" ry="1.4" fill="none" stroke="#e8c766" stroke-width="1"/>' +
  '<path d="M1.7 2.6v6.3c0 .8 1.9 1.4 4.3 1.4s4.3-.6 4.3-1.4V2.6" fill="none" stroke="#e8c766" stroke-width="1"/>' +
  '<path d="M1.7 5.8c0 .8 1.9 1.4 4.3 1.4s4.3-.6 4.3-1.4" fill="none" stroke="#e8c766" stroke-width="1"/>';

function pillIconDataUri(inner) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">${inner}</svg>`)}`;
}
const PROJ_ICON_URI = pillIconDataUri(PROJ_ICON_SVG);
const NET_ICON_URI = pillIconDataUri(NET_ICON_SVG);
const MOUNT_BIND_ICON_URI = pillIconDataUri(MOUNT_BIND_ICON_SVG);
const MOUNT_VOLUME_ICON_URI = pillIconDataUri(MOUNT_VOLUME_ICON_SVG);

// A mount/volume referenced by 2+ containers (data('shared'), set in buildTreeElements) is
// shared infrastructure - worth flagging at a glance over and above its bind-vs-volume kind, so
// it gets this color instead of the usual amber/light-yellow regardless of which of those it is.
export const SHARED_MOUNT_COLOR = '#f0883e';

// Matches the CPU/mem color convention used everywhere else (host tiles, sparklines): CPU is
// always --accent, mem always --seq-mem, regardless of value - magnitude is bar length, not
// color, so the two bars stay identifiable instead of both turning red/amber/green as they fill.
export const CPU_COLOR = '#4f8cff';
export const MEM_COLOR = '#199e70';

// Blast-radius selection tint - shared between CY_STYLE below (live view) and svgExport.js (the
// hand-drawn exporter has to match it exactly rather than reference it via a canvas style).
export const BLAST_UPSTREAM_COLOR = '#a371f7';
export const BLAST_DOWNSTREAM_COLOR = '#f0883e';

// Graph mode's cross-project shared-network edge. Used to be var(--border) (#2b2f38), muted to
// read as background but nearly invisible once zoomed out far. --seq-net is the app's own
// network-associated hue, already validated for contrast (style.css) - the natural fix.
export const NETWORK_COLOR = '#d160a8';

export const CY_STYLE = [
  {
    selector: 'node.group',
    style: {
      'background-color': '#1d2027',
      'border-width': 1.5,
      // Was #2b2f38 (var(--border)) - too close to the canvas background to read as a box outline
      // at a glance. Matches the label's own color instead of introducing a third gray - the box
      // is now exactly as visible as the project name sitting inside it.
      'border-color': '#8b909c',
      label: 'data(label)',
      'font-size': 12,
      color: '#8b909c',
      'text-valign': 'top',
      'text-halign': 'center',
      padding: '18px',
      shape: 'round-rectangle',
    },
  },
  {
    // Applied by cytoscape-expand-collapse to the node left standing once a group collapses - it
    // keeps the 'group' class too (same element), so this comes after it to win the cascade.
    // label is blanked like leaf nodes; the html-label overlay carries all the text instead.
    selector: 'node.cy-expand-collapse-collapsed-node',
    style: {
      'background-color': '#1d2027',
      'border-width': 1.5,
      'border-color': '#8b909c',
      label: '',
      width: 170,
      height: (ele) => (ele.data('compact') ? COMPACT_HEIGHT : 88),
      shape: 'round-rectangle',
    },
  },
  {
    selector: 'node.running',
    style: {
      'background-color': '#1d2027',
      'border-width': 2,
      'border-color': '#3fb950',
      width: 170,
      height: (ele) => (ele.data('compact') ? COMPACT_HEIGHT : containerFullHeight(ele.data('portLines'))),
      shape: 'round-rectangle',
    },
  },
  {
    selector: 'node.stopped',
    style: {
      'background-color': '#1d2027',
      'border-width': 2,
      'border-color': '#8b909c',
      width: 170,
      height: (ele) => (ele.data('compact') ? COMPACT_HEIGHT : containerFullHeight(ele.data('portLines'))),
      shape: 'round-rectangle',
    },
  },
  {
    // Created but never started - dashed like .log-panel.pane-desynced elsewhere in this app,
    // reusing that same "dashed = not in its normal state" visual language, in --accent (matches
    // state-created in style.css) so it doesn't read as gray/stopped at a glance.
    selector: 'node.created',
    style: {
      'background-color': '#1d2027',
      'border-width': 2,
      'border-color': '#4f8cff',
      'border-style': 'dashed',
      width: 170,
      height: (ele) => (ele.data('compact') ? COMPACT_HEIGHT : containerFullHeight(ele.data('portLines'))),
      shape: 'round-rectangle',
    },
  },
  {
    selector: 'node.starting',
    style: {
      'border-color': '#d29922',
    },
  },
  {
    selector: 'node.unhealthy',
    style: {
      'border-color': '#f85149',
    },
  },
  {
    selector: 'node.selected',
    style: {
      'border-color': '#4f8cff',
      'border-width': 4,
    },
  },
  {
    // Blast radius tint on selection - background only (border stays driven by health/selected
    // state above) so an unhealthy node inside the blast radius still reads as unhealthy first.
    selector: 'node.blast-upstream',
    style: {
      'background-color': BLAST_UPSTREAM_COLOR,
      'background-opacity': 0.22,
    },
  },
  {
    selector: 'node.blast-downstream',
    style: {
      'background-color': BLAST_DOWNSTREAM_COLOR,
      'background-opacity': 0.22,
    },
  },
  {
    selector: 'edge.edge-network',
    style: {
      'line-color': NETWORK_COLOR,
      width: 3,
      'curve-style': 'bezier',
      'line-style': 'dashed',
      'target-arrow-shape': 'none',
    },
  },
  {
    selector: 'edge.edge-depends-on',
    style: {
      'line-color': '#199e70',
      width: 2,
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#199e70',
      label: 'data(label)',
      'font-size': 10,
      color: '#199e70',
      'text-background-color': '#14161a',
      'text-background-opacity': 1,
    },
  },
  {
    selector: 'edge.edge-manual',
    style: {
      'line-color': '#4f8cff',
      width: 2,
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#4f8cff',
      label: 'data(label)',
      'font-size': 10,
      color: '#4f8cff',
      'text-background-color': '#14161a',
      'text-background-opacity': 1,
    },
  },
  {
    // Tree mode only - project/network/mount pills are plain (non-compound) nodes, fixed-size
    // with a centered label, unlike node.group's padding-around-children. A darker blue than
    // node.net's border (not node.stopped's gray) so a project reads as a grouping, not a state.
    selector: 'node.proj',
    style: {
      'background-color': '#1d2027',
      'border-width': 1,
      'border-color': '#2d5fa8',
      label: 'data(label)',
      'font-size': 11,
      color: '#e4e6eb',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-margin-x': 8,
      width: 140,
      height: 30,
      shape: 'round-rectangle',
      'background-image': PROJ_ICON_URI,
      'background-width': 12,
      'background-height': 12,
      'background-position-x': 10,
      'background-position-y': '50%',
      'background-repeat': 'no-repeat',
      'background-clip': 'none',
    },
  },
  {
    selector: 'node.net',
    style: {
      // A long "<project>_<network>" name used to overflow this fixed-height, single-line pill
      // past its own border - wrap + height: 'label' grows the box the same way node.mount
      // already handles long bind-mount paths (see wrapPillLabel), rather than truncating it.
      'background-color': '#182234',
      'border-width': 1,
      'border-color': '#4f8cff',
      label: 'data(label)',
      'font-size': 10,
      color: '#4f8cff',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      'text-max-width': 95,
      'text-margin-x': 7,
      width: 120,
      height: 'label',
      padding: '6px',
      shape: 'round-rectangle',
      'background-image': NET_ICON_URI,
      'background-width': 11,
      'background-height': 11,
      'background-position-x': 8,
      'background-position-y': '50%',
      'background-repeat': 'no-repeat',
      'background-clip': 'none',
    },
  },
  {
    // Bind-mount source paths can be much longer than a network/project name - fixed width with
    // text-wrap forces them onto multiple lines; height: 'label' grows the box to fit them.
    // Colors/icon split into .mount-bind/.mount-volume below, since those are different Docker concepts.
    selector: 'node.mount',
    style: {
      label: 'data(label)',
      'font-size': 10,
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      'text-max-width': 150,
      'text-margin-x': 9,
      width: 170,
      height: 'label',
      padding: '8px',
      shape: 'round-rectangle',
      'background-width': 12,
      'background-height': 12,
      'background-position-x': 8,
      'background-position-y': '50%',
      'background-repeat': 'no-repeat',
      'background-clip': 'none',
    },
  },
  {
    selector: 'node.mount-bind',
    style: {
      'background-color': '#241d14',
      'border-width': 1,
      'border-color': '#d29922',
      color: '#d29922',
      'background-image': MOUNT_BIND_ICON_URI,
    },
  },
  {
    selector: 'node.mount-volume',
    style: {
      'background-color': '#2b2413',
      'border-width': 1,
      'border-color': '#e8c766',
      color: '#e8c766',
      'background-image': MOUNT_VOLUME_ICON_URI,
    },
  },
  {
    // Listed after .mount-bind/.mount-volume so this wins the border/text/background color
    // cascade for a shared mount or volume without needing to also repeat their
    // background-image - the folder/cylinder icon still shows which kind it is underneath.
    selector: 'node.mount[?shared]',
    style: {
      'background-color': '#2e1c0f',
      'border-color': SHARED_MOUNT_COLOR,
      color: SHARED_MOUNT_COLOR,
    },
  },
  {
    // Orthogonal "taxi" routing, matching ArgoCD's resource tree connectors - reads more like a
    // hierarchy diagram than graph mode's diagonal bezier edges. No arrowhead: left-to-right
    // position already conveys direction. Split into 3 kind-specific styles so lines converging on shared pills don't blend.
    selector: 'edge.edge-tree-proj',
    style: {
      'line-color': '#3a3f4b',
      width: 1.5,
      'curve-style': 'taxi',
      'taxi-direction': 'horizontal',
      'taxi-turn': '50%',
      'taxi-turn-min-distance': 10,
      'target-arrow-shape': 'none',
    },
  },
  {
    // Straight rather than taxi routing - a network pill shared by many containers at different
    // heights gets orthogonal elbows that overlap along the same horizontal bands. A direct line
    // fans out at a distinct angle per source, staying readable at higher fan-in.
    selector: 'edge.edge-tree-net',
    style: {
      'line-color': '#4f8cff',
      width: 1.5,
      'line-style': 'dashed',
      'curve-style': 'straight',
      'target-arrow-shape': 'none',
    },
  },
  {
    // Taxi (orthogonal), matching edge-tree-proj's ArgoCD look. Briefly switched to 'straight' to
    // chase an invisible-line bug that turned out to be a stale-render issue (see
    // updateCompactFlag's cy.style().update()), not a taxi-geometry one - fixed at the source.
    selector: 'edge.edge-tree-mount',
    style: {
      // Matches whichever pill it leads to (shared orange, else mount-bind's darker amber vs
      // mount-volume's lighter yellow) rather than one flat color, so the line itself hints at
      // what's on the other end before you even reach the pill.
      'line-color': (edge) => {
        const target = edge.target();
        if (target.data('shared')) return SHARED_MOUNT_COLOR;
        return target.hasClass('mount-volume') ? '#e8c766' : '#d29922';
      },
      width: 1.5,
      'curve-style': 'taxi',
      'taxi-direction': 'horizontal',
      'taxi-turn': '50%',
      'taxi-turn-min-distance': 10,
      'target-arrow-shape': 'none',
    },
  },
  {
    selector: 'edge.blast-upstream',
    style: {
      'line-color': BLAST_UPSTREAM_COLOR,
      'target-arrow-color': BLAST_UPSTREAM_COLOR,
      width: 3,
    },
  },
  {
    selector: 'edge.blast-downstream',
    style: {
      'line-color': BLAST_DOWNSTREAM_COLOR,
      'target-arrow-color': BLAST_DOWNSTREAM_COLOR,
      width: 3,
    },
  },
  {
    // Kept last so it wins over the node/edge kind selectors above regardless of element type.
    selector: '.faded',
    style: {
      opacity: 0.15,
    },
  },
];
