import { healthColor } from '../format.js';
import { STATE_COLORS, SELECTED } from '../theme.js';
import {
  NODE_WIDTH,
  FULL_LEAF_HEIGHT,
  FULL_GROUP_HEIGHT,
  PORT_EXTRA_LINE_HEIGHT,
  containerFullHeight,
  clampPct,
  CONTAINER_STATE_CLASSES,
} from './elements.js';
import {
  CPU_COLOR,
  MEM_COLOR,
  SHARED_MOUNT_COLOR,
  BLAST_UPSTREAM_COLOR,
  BLAST_DOWNSTREAM_COLOR,
  NETWORK_COLOR,
  PROJ_ICON_SVG,
  NET_ICON_SVG,
  MOUNT_BIND_ICON_SVG,
  MOUNT_VOLUME_ICON_SVG,
} from './style.js';

// A vector export has no resolution ceiling to manage, unlike exportPng's EXPORT_SCALE dance -
// the viewBox just grows to fit. extractSvgGeometry (impure, reads live cy) and renderSvg (pure,
// geometry -> markup) mirror buildElements' pure-core/impure-adapter split; renderSvg is unit-tested.

const ALERT_BADGE_COLOR = '#e5534b';

function svgEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function svgTruncate(str, max) {
  const s = str || '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function svgNodeKind(n) {
  if (n.hasClass('cy-expand-collapse-collapsed-node')) return 'group-collapsed';
  if (n.hasClass('group')) return 'group-expanded';
  if (n.hasClass('proj')) return 'proj';
  if (n.hasClass('net')) return 'net';
  if (n.hasClass('mount-bind')) return 'mount-bind';
  if (n.hasClass('mount-volume')) return 'mount-volume';
  if (CONTAINER_STATE_CLASSES.some((c) => n.hasClass(c))) return 'container';
  return null;
}

// Text line spacing for a wrapped mount label, in svgPillNode below - kept as a shared constant
// only so the "why 12" stays in one place.
const MOUNT_PILL_LINE_HEIGHT = 12;

function svgEdgeKind(e) {
  if (e.hasClass('edge-network')) return 'network';
  if (e.hasClass('edge-depends-on')) return 'depends_on';
  if (e.hasClass('edge-manual')) return 'manual';
  if (e.hasClass('edge-tree-proj')) return 'tree-proj';
  if (e.hasClass('edge-tree-net')) return 'tree-net';
  if (e.hasClass('edge-tree-mount')) return 'tree-mount';
  return null;
}

// Reads whatever's currently rendered into plain, cytoscape-free data - the opposite direction
// from buildElements (data -> cy elements). Leaf/collapsed-group sizing ignores the node's
// current compact-shrunk height in favor of the full-size CY_STYLE height: no zoom-driven reason to hide detail here.
export function extractSvgGeometry(cy) {
  const nodes = [];
  cy.nodes().forEach((n) => {
    const kind = svgNodeKind(n);
    if (!kind) return;
    let x, y, width, height;
    if (kind === 'group-expanded') {
      const bb = n.boundingBox();
      x = bb.x1 + bb.w / 2;
      y = bb.y1 + bb.h / 2;
      width = bb.w;
      height = bb.h;
    } else {
      const pos = n.position();
      x = pos.x;
      y = pos.y;
      if (kind === 'container') {
        width = NODE_WIDTH;
        height = containerFullHeight(n.data('portLines'));
      } else if (kind === 'group-collapsed') {
        width = NODE_WIDTH;
        height = FULL_GROUP_HEIGHT;
      } else {
        // Trust cytoscape's own live height here (unlike leaf/collapsed-group nodes above) -
        // dagre spaced this node's siblings assuming exactly this height, so drawing it taller
        // would overlap a neighbor. svgPillNode fits text into this height, not the other way.
        width = n.width();
        height = n.height();
      }
    }
    nodes.push({
      id: n.id(),
      kind,
      x,
      y,
      width,
      height,
      data: n.data(),
      running: n.hasClass('running'),
      stopped: n.hasClass('stopped'),
      created: n.hasClass('created'),
      starting: n.hasClass('starting'),
      unhealthy: n.hasClass('unhealthy'),
      selected: n.hasClass('selected'),
      faded: n.hasClass('faded'),
      blastUpstream: n.hasClass('blast-upstream'),
      blastDownstream: n.hasClass('blast-downstream'),
    });
  });

  const edges = [];
  cy.edges().forEach((e) => {
    const kind = svgEdgeKind(e);
    if (!kind) return;
    // Same signal CY_STYLE's edge-tree-mount line-color function reads off the live target node
    // (see style.js) - carried into the plain geometry here since svgEdge has no cytoscape node
    // to query later, only the extracted target point.
    const mountShared = kind === 'tree-mount' ? Boolean(e.target().data('shared')) : false;
    const mountVolume = kind === 'tree-mount' ? e.target().hasClass('mount-volume') : false;
    edges.push({
      id: e.id(),
      kind,
      source: e.sourceEndpoint(),
      target: e.targetEndpoint(),
      label: e.data('label') || '',
      faded: e.hasClass('faded'),
      blastUpstream: e.hasClass('blast-upstream'),
      blastDownstream: e.hasClass('blast-downstream'),
      mountShared,
      mountVolume,
    });
  });

  return { nodes, edges };
}

// Mirrors .cy-node-metric-row: a "CPU"/"RAM" label (20px, matching .cy-node-metric-label's own
// width) then the track fills the rest - the live template has never had bars with no label next
// to them, so a bar alone here read as broken rather than just "0%".
function svgMetricBars(x, y, width, cpuPct, memPct) {
  const labelWidth = 20;
  const trackX = x + labelWidth + 4;
  const trackWidth = width - labelWidth - 4;
  const rowGap = 6;
  return (
    `<text x="${x}" y="${y + 2.5}" font-size="5" font-weight="700" fill="#8b909c">CPU</text>` +
    `<rect x="${trackX}" y="${y}" width="${trackWidth}" height="3" rx="1.5" fill="rgba(255,255,255,0.07)"/>` +
    `<rect x="${trackX}" y="${y}" width="${(trackWidth * clampPct(cpuPct)) / 100}" height="3" rx="1.5" fill="${CPU_COLOR}"/>` +
    `<text x="${x}" y="${y + rowGap + 2.5}" font-size="5" font-weight="700" fill="#8b909c">RAM</text>` +
    `<rect x="${trackX}" y="${y + rowGap}" width="${trackWidth}" height="3" rx="1.5" fill="rgba(255,255,255,0.07)"/>` +
    `<rect x="${trackX}" y="${y + rowGap}" width="${(trackWidth * clampPct(memPct)) / 100}" height="3" rx="1.5" fill="${MEM_COLOR}"/>`
  );
}

function svgAlertBadge(x, y, count) {
  return `<circle cx="${x + 6}" cy="${y + 6}" r="6" fill="${ALERT_BADGE_COLOR}"/><text x="${x + 6}" y="${y + 9}" text-anchor="middle" font-size="8" fill="#fff">${count}</text>`;
}

// Mirrors the .cy-node-box HTML template's layout (public/style.css:491-618): state icon top
// right, service badge + name, CPU/RAM bar rows, NET/DISK text, port/alert badges.
function svgContainerNode(n) {
  const d = n.data;
  const x1 = n.x - n.width / 2;
  const y1 = n.y - n.height / 2;
  // The same precedence CY_STYLE gets from selector order (created -> starting -> unhealthy ->
  // selected), spelled out because there are no cascading selectors here - but off the same
  // theme.js values, so the export can no longer drift from the screen. See CLAUDE.md.
  let border = n.created ? STATE_COLORS.created : n.stopped ? STATE_COLORS.stopped : STATE_COLORS.running;
  if (n.starting) border = STATE_COLORS.starting;
  if (n.unhealthy) border = STATE_COLORS.unhealthy;
  if (n.selected) border = SELECTED;
  const dash = n.created ? ' stroke-dasharray="6 4"' : '';
  let svg = `<g opacity="${n.faded ? 0.15 : 1}">`;
  if (n.blastUpstream)
    svg += `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="8" fill="${BLAST_UPSTREAM_COLOR}" fill-opacity="0.22"/>`;
  if (n.blastDownstream)
    svg += `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="8" fill="${BLAST_DOWNSTREAM_COLOR}" fill-opacity="0.22"/>`;
  svg += `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="8" fill="#1d2027" stroke="${border}" stroke-width="2"${dash}/>`;
  if (d.emoji) svg += `<g transform="translate(${x1 + n.width - 17}, ${y1 + 2})">${d.emoji}</g>`;
  if (d.status) svg += `<text x="${x1 + 18}" y="${y1 + 10}" font-size="9" fill="#8b909c">${svgEscape(svgTruncate(d.status, 22))}</text>`;
  if (d.icon) {
    svg += `<circle cx="${x1 + 14.5}" cy="${y1 + 24.5}" r="8.5" fill="${d.icon.bg}"/>`;
    svg += `<text x="${x1 + 14.5}" y="${y1 + 27.5}" text-anchor="middle" font-size="8" font-weight="600" fill="#fff">${svgEscape(d.icon.text)}</text>`;
  }
  svg += `<text x="${n.x}" y="${y1 + 28}" text-anchor="middle" font-size="11" fill="#e4e6eb">${svgEscape(svgTruncate(d.name, 18))}</text>`;
  // Fixed offsets from FULL_LEAF_HEIGHT (single-port-line box height), not n.height - n.height
  // grows to fit a wrapped port list, and that extra room must land below this cluster, not
  // stretch the gap above it (which anchoring to the real, taller n.height would do).
  svg += svgMetricBars(x1 + 8, y1 + FULL_LEAF_HEIGHT - 32, n.width - 16, d.cpuPerc, d.memPerc);
  svg += `<text x="${x1 + 8}" y="${y1 + FULL_LEAF_HEIGHT - 10}" font-size="5" fill="#8b909c">NET ${svgEscape(d.netIO)}  DISK ${svgEscape(d.blockIO)}</text>`;
  if (d.ports) {
    const portTspans = d.ports
      .split('\n')
      .map((line, i) => `<tspan x="${x1 + 6}" y="${y1 + FULL_LEAF_HEIGHT - 2 + i * PORT_EXTRA_LINE_HEIGHT}">${svgEscape(line)}</tspan>`)
      .join('');
    svg += `<text font-size="8" fill="#8b909c">${portTspans}</text>`;
  }
  if (d.openAlerts > 0) svg += svgAlertBadge(x1 + 4, y1 + 2, d.openAlerts);
  svg += `</g>`;
  return svg;
}

// Collapsed compose group - mirrors the cy-expand-collapse-collapsed-node HTML template (health
// dot, container count, averaged CPU/RAM). An *expanded* group (svgGroupBox below) shows none of
// that - it's just the padded outline + label the live view actually draws for one.
function svgGroupNode(n) {
  const d = n.data;
  const x1 = n.x - n.width / 2;
  const y1 = n.y - n.height / 2;
  const count = d.count || 0;
  let svg = `<g opacity="${n.faded ? 0.15 : 1}">`;
  svg += `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="8" fill="#1d2027" stroke="#8b909c" stroke-width="1.5"/>`;
  if (d.health) svg += `<circle cx="${x1 + n.width - 10}" cy="${y1 + 8}" r="3.5" fill="${healthColor(d.health)}"/>`;
  svg += `<text x="${n.x}" y="${y1 + 26}" text-anchor="middle" font-size="11" fill="#e4e6eb">${svgEscape(d.label)}</text>`;
  svg += `<text x="${n.x}" y="${y1 + 42}" text-anchor="middle" font-size="9" fill="#8b909c">${count} container${count === 1 ? '' : 's'}</text>`;
  svg += svgMetricBars(x1 + 8, y1 + n.height - 24, n.width - 16, d.cpuAvg, d.memAvg);
  if (d.openAlerts > 0) svg += svgAlertBadge(x1 + 4, y1 + 2, d.openAlerts);
  svg += `</g>`;
  return svg;
}

function svgGroupBox(n) {
  const x1 = n.x - n.width / 2;
  const y1 = n.y - n.height / 2;
  return (
    `<g opacity="${n.faded ? 0.15 : 1}">` +
    `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="8" fill="#1d2027" stroke="#8b909c" stroke-width="1.5"/>` +
    `<text x="${n.x}" y="${y1 + 16}" text-anchor="middle" font-size="12" fill="#8b909c">${svgEscape(n.data.label)}</text>` +
    `</g>`
  );
}

// Mirrors the live view's CY_STYLE background-image icons (style.js's PROJ_ICON_SVG etc.) -
// drawn as real SVG elements since the exporter has no canvas to reference a background-image
// on. Icon coordinates are already in the shared 0-12 space; this just positions it at the pill's edge.
function svgPillIcon(kind, x1, cy) {
  const svg = { proj: PROJ_ICON_SVG, net: NET_ICON_SVG, 'mount-bind': MOUNT_BIND_ICON_SVG, 'mount-volume': MOUNT_VOLUME_ICON_SVG }[kind];
  if (!svg) return '';
  return `<g transform="translate(${x1 + 2}, ${cy - 6})">${svg}</g>`;
}

// Shifts the pill's text right of center, mirroring CY_STYLE's text-margin-x, to leave room for
// svgPillIcon at the left edge.
const PILL_ICON_TEXT_SHIFT = 8;

// Tree mode's project/network/mount pills, matching CY_STYLE's node.proj/.net/.mount(-bind|-volume).
// Mount labels already carry \n for wrapped paths, split into one <tspan> per line. The box is
// always exactly n.height (dagre spaced siblings by it); line spacing shrinks to fit instead of the box growing.
function svgPillNode(n, { border, text, bg }) {
  const lines = String(n.data.label || '').split('\n');
  const x1 = n.x - n.width / 2;
  const y1 = n.y - n.height / 2;
  const textX = n.x + PILL_ICON_TEXT_SHIFT;
  const vPadding = 6;
  const lineHeight =
    lines.length > 1 ? Math.max(8, Math.min(MOUNT_PILL_LINE_HEIGHT, (n.height - vPadding) / lines.length)) : MOUNT_PILL_LINE_HEIGHT;
  const textBlockHeight = lines.length * lineHeight;
  const firstBaselineY = n.y - textBlockHeight / 2 + lineHeight * 0.75;
  const tspans = lines.map((line, i) => `<tspan x="${textX}" y="${firstBaselineY + i * lineHeight}">${svgEscape(line)}</tspan>`).join('');
  return (
    `<g opacity="${n.faded ? 0.15 : 1}">` +
    `<rect x="${x1}" y="${y1}" width="${n.width}" height="${n.height}" rx="6" fill="${bg}" stroke="${border}" stroke-width="1"/>` +
    svgPillIcon(n.kind, x1, n.y) +
    `<text x="${textX}" text-anchor="middle" font-size="10" fill="${text}">${tspans}</text>` +
    `</g>`
  );
}

function svgNode(n) {
  switch (n.kind) {
    case 'container':
      return svgContainerNode(n);
    case 'group-collapsed':
      return svgGroupNode(n);
    case 'group-expanded':
      return svgGroupBox(n);
    case 'proj':
      return svgPillNode(n, { border: '#2d5fa8', text: '#e4e6eb', bg: '#1d2027' });
    case 'net':
      return svgPillNode(n, { border: '#4f8cff', text: '#4f8cff', bg: '#182234' });
    case 'mount-bind':
      return n.data.shared
        ? svgPillNode(n, { border: SHARED_MOUNT_COLOR, text: SHARED_MOUNT_COLOR, bg: '#2e1c0f' })
        : svgPillNode(n, { border: '#d29922', text: '#d29922', bg: '#241d14' });
    case 'mount-volume':
      return n.data.shared
        ? svgPillNode(n, { border: SHARED_MOUNT_COLOR, text: SHARED_MOUNT_COLOR, bg: '#2e1c0f' })
        : svgPillNode(n, { border: '#e8c766', text: '#e8c766', bg: '#2b2413' });
    default:
      return '';
  }
}

const EDGE_SVG_STYLE = {
  network: { color: NETWORK_COLOR, dash: '6,4', arrow: false, taxi: false },
  depends_on: { color: '#199e70', dash: null, arrow: true, taxi: false },
  manual: { color: '#4f8cff', dash: null, arrow: true, taxi: false },
  'tree-proj': { color: '#3a3f4b', dash: null, arrow: false, taxi: true },
  'tree-net': { color: '#4f8cff', dash: '6,4', arrow: false, taxi: false },
  'tree-mount': { color: '#d29922', dash: null, arrow: false, taxi: true },
};

// Matches CY_STYLE's taxi-turn: '50%' - a horizontal-vertical-horizontal elbow turning at the
// x-midpoint between source and target, same formula cytoscape itself uses for edge-tree-proj/
// edge-tree-mount.
function taxiPoints(source, target) {
  const midX = (source.x + target.x) / 2;
  return [source, { x: midX, y: source.y }, { x: midX, y: target.y }, target];
}

function svgArrowHead(from, to, color) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 7;
  const spread = 0.4;
  const p1 = { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) };
  const p2 = { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) };
  return `<polygon points="${to.x},${to.y} ${p1.x},${p1.y} ${p2.x},${p2.y}" fill="${color}"/>`;
}

// Mirrors CY_STYLE's edge-tree-mount line-color function: EDGE_SVG_STYLE's flat color is only
// the mount-bind default. A shared mount/volume wins over kind, same as the live view - losing
// that here would lose the point of the shared-mount signal the legend advertises.
function treeMountColor(e, fallback) {
  if (e.mountShared) return SHARED_MOUNT_COLOR;
  if (e.mountVolume) return '#e8c766';
  return fallback;
}

// Graph-mode edges (network/depends-on/manual) are bezier-curved in the live view - drawn here
// as straight lines rather than reverse-engineering cytoscape's bezier control-point math, which
// isn't worth the complexity for a visual difference this minor.
function svgEdge(e) {
  const style = EDGE_SVG_STYLE[e.kind];
  if (!style) return '';
  let color = e.kind === 'tree-mount' ? treeMountColor(e, style.color) : style.color;
  let width = 1.5;
  if (e.blastUpstream) {
    color = BLAST_UPSTREAM_COLOR;
    width = 3;
  } else if (e.blastDownstream) {
    color = BLAST_DOWNSTREAM_COLOR;
    width = 3;
  }
  const points = style.taxi ? taxiPoints(e.source, e.target) : [e.source, e.target];
  const pointsAttr = points.map((p) => `${p.x},${p.y}`).join(' ');
  const dashAttr = style.dash ? ` stroke-dasharray="${style.dash}"` : '';
  let svg = `<g opacity="${e.faded ? 0.15 : 1}">`;
  svg += `<polyline points="${pointsAttr}" fill="none" stroke="${color}" stroke-width="${width}"${dashAttr}/>`;
  if (style.arrow) svg += svgArrowHead(points[points.length - 2], points[points.length - 1], color);
  if (e.label) {
    const mx = (e.source.x + e.target.x) / 2;
    const my = (e.source.y + e.target.y) / 2;
    const label = svgEscape(e.label);
    const boxWidth = label.length * 5.5 + 8;
    svg += `<rect x="${mx - boxWidth / 2}" y="${my - 7}" width="${boxWidth}" height="14" fill="#14161a"/>`;
    svg += `<text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="10" fill="${color}">${label}</text>`;
  }
  svg += `</g>`;
  return svg;
}

// Pure: geometry (from extractSvgGeometry, or a synthetic fixture in tests) -> a complete <svg>
// document string. The viewBox grows to fit every node's bounds plus padding - no fixed
// resolution/size decision to make, unlike the PNG export.
export function renderSvg(geometry, { background = '#14161a' } = {}) {
  const { nodes, edges } = geometry;
  if (!nodes.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="${background}"/></svg>`;
  }
  const PAD = 40;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.width / 2);
    minY = Math.min(minY, n.y - n.height / 2);
    maxX = Math.max(maxX, n.x + n.width / 2);
    maxY = Math.max(maxY, n.y + n.height / 2);
  }
  minX -= PAD;
  minY -= PAD;
  maxX += PAD;
  maxY += PAD;
  const width = maxX - minX;
  const height = maxY - minY;

  const edgesSvg = edges.map(svgEdge).join('\n');
  const nodesSvg = nodes.map(svgNode).join('\n');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="${width}" height="${height}" font-family="sans-serif">`,
    `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${background}"/>`,
    edgesSvg,
    nodesSvg,
    `</svg>`,
  ].join('\n');
}

// cy.fit-to-all before extracting, matching exportPng - always captures the whole graph, not
// just the viewport. No container-resize/frame-wait needed like exportPng: this reads
// cytoscape's own bounding boxes, current the moment fit() returns, and never touches the DOM overlay.
export async function exportSvg(cy) {
  if (!cy) return;
  const savedViewport = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  cy.fit(undefined, 30);

  const svgString = renderSvg(extractSvgGeometry(cy));
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `opendockwatch-flow-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  cy.viewport(savedViewport);
}
