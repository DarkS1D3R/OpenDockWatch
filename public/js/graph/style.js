import { containerFullHeight } from './elements.js';
// The container state/health borders below come from here, not from literals: svgExport.js
// hand-draws the same five and used to carry its own copies, so the export could silently
// disagree with the screen. The pill/group colours further down are their own vocabulary.
import { PALETTES, stateColorsFor } from '../theme.js';

// Below this zoom, a fit-to-screen view of more than a handful of containers is mostly
// unreadable anyway - compact mode trades CPU/RAM bars and metric text for just enough to answer
// "what is this and is it OK". Set high so only native-size-or-closer viewing keeps full metrics.
export const COMPACT_ZOOM_THRESHOLD = 1;
const COMPACT_HEIGHT = 34;

// The graph's own vocabulary (pills, edges, blast tint) per app colour scheme. Cytoscape draws on a
// canvas and cannot read CSS custom properties, so a theme switch rebuilds the stylesheet from
// here (graph.js) rather than inheriting it. State borders still come from theme.js.
export const GRAPH_PALETTES = {
  dark: {
    canvas: '#14161a',
    surface: '#1d2027',
    text: '#e4e6eb',
    muted: PALETTES.dark.muted,
    accent: PALETTES.dark.accent,
    projBorder: '#2d5fa8',
    netBg: '#182234',
    bind: '#d29922',
    bindBg: '#241d14',
    volume: '#e8c766',
    volumeBg: '#2b2413',
    // A mount/volume referenced by 2+ containers (data('shared'), set in buildTreeElements) is
    // shared infrastructure - flagged over and above its bind-vs-volume kind.
    shared: '#f0883e',
    sharedBg: '#2e1c0f',
    // CPU is always the accent and mem always --seq-mem, matching the host tiles: magnitude is bar
    // length, not colour, so the two bars stay identifiable as they fill.
    cpu: PALETTES.dark.accent,
    mem: '#199e70',
    // Graph mode's cross-project shared-network edge: --seq-net, already validated (style.css).
    network: '#d160a8',
    blastUpstream: '#a371f7',
    blastDownstream: '#f0883e',
    treeEdge: '#3a3f4b',
    track: 'rgba(255,255,255,0.07)',
    alert: '#e5534b',
  },
  light: {
    canvas: '#e2e6eb',
    surface: '#eceff3',
    text: '#1f242c',
    muted: PALETTES.light.muted,
    accent: PALETTES.light.accent,
    projBorder: '#4f74b8',
    netBg: '#dbe4f3',
    bind: '#865a00',
    bindBg: '#efe6d4',
    volume: '#76620f',
    volumeBg: '#ece7d0',
    shared: '#b4530f',
    sharedBg: '#f1e0d2',
    cpu: PALETTES.light.accent,
    mem: '#117a55',
    network: '#cc4f9a',
    blastUpstream: '#7c4fd1',
    blastDownstream: '#c45d12',
    treeEdge: '#a3abb7',
    track: 'rgba(20,30,45,0.10)',
    alert: '#b62d28',
  },
};

export function graphPalette(scheme) {
  return GRAPH_PALETTES[scheme] || GRAPH_PALETTES.dark;
}

// Small "what type of node is this" glyphs for tree mode's pills - real inline SVG, reused two
// ways: a data URI for the cytoscape background-image (live canvas + PNG export), and inlined <g>
// markup by svgExport.js's svgPillIcon (no canvas to reference). Shared 0-12 coordinate space.
export function pillIconSvg(kind, p) {
  switch (kind) {
    case 'proj':
      return (
        `<path d="M6 1.2 11 3.6 6 6 1 3.6Z" fill="none" stroke="${p.projBorder}" stroke-width="1" stroke-linejoin="round"/>` +
        `<path d="M1.5 6 6 8.2 10.5 6" fill="none" stroke="${p.projBorder}" stroke-width="1" stroke-linejoin="round"/>` +
        `<path d="M1.5 8.4 6 10.6 10.5 8.4" fill="none" stroke="${p.projBorder}" stroke-width="1" stroke-linejoin="round"/>`
      );
    case 'net':
      return (
        `<circle cx="6" cy="2" r="1.3" fill="${p.accent}"/><circle cx="2" cy="9.5" r="1.3" fill="${p.accent}"/><circle cx="10" cy="9.5" r="1.3" fill="${p.accent}"/>` +
        `<path d="M6 3.3 2 8.3M6 3.3 10 8.3" stroke="${p.accent}" stroke-width="1"/>`
      );
    case 'mount-bind':
      return `<path d="M1.5 3.3c0-.7.6-1.3 1.3-1.3h2l1 1h3.4c.7 0 1.3.6 1.3 1.3v4.4c0 .7-.6 1.3-1.3 1.3H2.8c-.7 0-1.3-.6-1.3-1.3Z" fill="none" stroke="${p.bind}" stroke-width="1" stroke-linejoin="round"/>`;
    case 'mount-volume':
      return (
        `<ellipse cx="6" cy="2.6" rx="4.3" ry="1.4" fill="none" stroke="${p.volume}" stroke-width="1"/>` +
        `<path d="M1.7 2.6v6.3c0 .8 1.9 1.4 4.3 1.4s4.3-.6 4.3-1.4V2.6" fill="none" stroke="${p.volume}" stroke-width="1"/>` +
        `<path d="M1.7 5.8c0 .8 1.9 1.4 4.3 1.4s4.3-.6 4.3-1.4" fill="none" stroke="${p.volume}" stroke-width="1"/>`
      );
    default:
      return '';
  }
}

function pillIconDataUri(kind, p) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">${pillIconSvg(kind, p)}</svg>`)}`;
}

export function cyStyleFor(scheme) {
  const p = graphPalette(scheme);
  const states = stateColorsFor(scheme);
  return [
    {
      selector: 'node.group',
      style: {
        'background-color': p.surface,
        'border-width': 1.5,
        // Was #2b2f38 (var(--border)) - too close to the canvas background to read as a box outline
        // at a glance. Matches the label's own color instead of introducing a third gray - the box
        // is now exactly as visible as the project name sitting inside it.
        'border-color': p.muted,
        label: 'data(label)',
        'font-size': 12,
        color: p.muted,
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
        'background-color': p.surface,
        'border-width': 1.5,
        'border-color': p.muted,
        label: '',
        width: 170,
        height: (ele) => (ele.data('compact') ? COMPACT_HEIGHT : 88),
        shape: 'round-rectangle',
      },
    },
    {
      selector: 'node.running',
      style: {
        'background-color': p.surface,
        'border-width': 2,
        'border-color': states.running,
        width: 170,
        height: (ele) => (ele.data('compact') ? COMPACT_HEIGHT : containerFullHeight(ele.data('portLines'))),
        shape: 'round-rectangle',
      },
    },
    {
      selector: 'node.stopped',
      style: {
        'background-color': p.surface,
        'border-width': 2,
        'border-color': states.stopped,
        width: 170,
        height: (ele) => (ele.data('compact') ? COMPACT_HEIGHT : containerFullHeight(ele.data('portLines'))),
        shape: 'round-rectangle',
      },
    },
    {
      // Created but never started - dashed like .log-panel.pane-desynced elsewhere in this app,
      // reusing that same "dashed = not in its normal state" visual language, in the accent (matches
      // state-created in style.css) so it doesn't read as gray/stopped at a glance.
      selector: 'node.created',
      style: {
        'background-color': p.surface,
        'border-width': 2,
        'border-color': states.created,
        'border-style': 'dashed',
        width: 170,
        height: (ele) => (ele.data('compact') ? COMPACT_HEIGHT : containerFullHeight(ele.data('portLines'))),
        shape: 'round-rectangle',
      },
    },
    {
      selector: 'node.starting',
      style: {
        'border-color': states.starting,
      },
    },
    {
      selector: 'node.unhealthy',
      style: {
        'border-color': states.unhealthy,
      },
    },
    {
      selector: 'node.selected',
      style: {
        'border-color': p.accent,
        'border-width': 4,
      },
    },
    {
      // Blast radius tint on selection - background only (border stays driven by health/selected
      // state above) so an unhealthy node inside the blast radius still reads as unhealthy first.
      selector: 'node.blast-upstream',
      style: {
        'background-color': p.blastUpstream,
        'background-opacity': 0.22,
      },
    },
    {
      selector: 'node.blast-downstream',
      style: {
        'background-color': p.blastDownstream,
        'background-opacity': 0.22,
      },
    },
    {
      selector: 'edge.edge-network',
      style: {
        'line-color': p.network,
        width: 3,
        'curve-style': 'bezier',
        'line-style': 'dashed',
        'target-arrow-shape': 'none',
      },
    },
    {
      selector: 'edge.edge-depends-on',
      style: {
        'line-color': p.mem,
        width: 2,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': p.mem,
        label: 'data(label)',
        'font-size': 10,
        color: p.mem,
        'text-background-color': p.canvas,
        'text-background-opacity': 1,
      },
    },
    {
      selector: 'edge.edge-manual',
      style: {
        'line-color': p.accent,
        width: 2,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': p.accent,
        label: 'data(label)',
        'font-size': 10,
        color: p.accent,
        'text-background-color': p.canvas,
        'text-background-opacity': 1,
      },
    },
    {
      // Tree mode only - project/network/mount pills are plain (non-compound) nodes with a centered
      // label, unlike node.group's padding-around-children. A darker blue than node.net's border
      // (not node.stopped's gray) so a project reads as a grouping, not a state.
      selector: 'node.proj',
      style: {
        // A long compose project name overflowed this pill exactly as long network names once
        // overflowed node.net - wrap + height: 'label' grows the box instead (see wrapPillLabel).
        // Padding adds to both axes: 120 + 2x10 keeps the 140px box, and a one-line pill at ~30px tall.
        'background-color': p.surface,
        'border-width': 1,
        'border-color': p.projBorder,
        label: 'data(label)',
        'font-size': 11,
        color: p.text,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': 105,
        'text-margin-x': 8,
        width: 120,
        height: 'label',
        padding: '10px',
        shape: 'round-rectangle',
        'background-image': pillIconDataUri('proj', p),
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
        'background-color': p.netBg,
        'border-width': 1,
        'border-color': p.accent,
        label: 'data(label)',
        'font-size': 10,
        color: p.accent,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': 95,
        'text-margin-x': 7,
        width: 120,
        height: 'label',
        padding: '6px',
        shape: 'round-rectangle',
        'background-image': pillIconDataUri('net', p),
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
        'background-color': p.bindBg,
        'border-width': 1,
        'border-color': p.bind,
        color: p.bind,
        'background-image': pillIconDataUri('mount-bind', p),
      },
    },
    {
      selector: 'node.mount-volume',
      style: {
        'background-color': p.volumeBg,
        'border-width': 1,
        'border-color': p.volume,
        color: p.volume,
        'background-image': pillIconDataUri('mount-volume', p),
      },
    },
    {
      // Listed after .mount-bind/.mount-volume so this wins the border/text/background color
      // cascade for a shared mount or volume without needing to also repeat their
      // background-image - the folder/cylinder icon still shows which kind it is underneath.
      selector: 'node.mount[?shared]',
      style: {
        'background-color': p.sharedBg,
        'border-color': p.shared,
        color: p.shared,
      },
    },
    {
      // Orthogonal "taxi" routing, matching ArgoCD's resource tree connectors - reads more like a
      // hierarchy diagram than graph mode's diagonal bezier edges. No arrowhead: left-to-right
      // position already conveys direction. Split into 3 kind-specific styles so lines converging on shared pills don't blend.
      selector: 'edge.edge-tree-proj',
      style: {
        'line-color': p.treeEdge,
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
        'line-color': p.accent,
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
          if (target.data('shared')) return p.shared;
          return target.hasClass('mount-volume') ? p.volume : p.bind;
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
        'line-color': p.blastUpstream,
        'target-arrow-color': p.blastUpstream,
        width: 3,
      },
    },
    {
      selector: 'edge.blast-downstream',
      style: {
        'line-color': p.blastDownstream,
        'target-arrow-color': p.blastDownstream,
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
}

// The dark stylesheet, for the tests that pin selector order and state colours.
export const CY_STYLE = cyStyleFor('dark');
