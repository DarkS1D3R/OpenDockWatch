import { stateEmoji, iconFor, parsePublishedPorts, formatRatePair } from '../format.js';

// Ranks worse-than semantics for a compose group's single "worst health" indicator when
// collapsed - unhealthy anywhere in the group outranks starting, which outranks a clean bill
// of health, so the collapsed box surfaces the thing you'd actually want to know about.
const HEALTH_RANK = { unhealthy: 3, starting: 2, healthy: 1 };

export function aggregateGroups(nodes) {
  const byGroup = new Map();
  for (const n of nodes) {
    const agg = byGroup.get(n.group) || { count: 0, cpuSum: 0, memSum: 0, openAlerts: 0, health: null };
    agg.count += 1;
    agg.cpuSum += n.cpuPerc || 0;
    agg.memSum += n.memPerc || 0;
    agg.openAlerts += n.openAlerts || 0;
    if (n.health && (!agg.health || HEALTH_RANK[n.health] > HEALTH_RANK[agg.health])) agg.health = n.health;
    byGroup.set(n.group, agg);
  }
  return byGroup;
}

export function clampPct(pct) {
  if (pct == null) return 0;
  return Math.max(0, Math.min(100, pct));
}

// Fixed leaf/collapsed-group box sizes and the port-badge line-wrap extra - shared by CY_STYLE's
// height functions (style.js), the layout/overlap code (layout.js), and the SVG exporter
// (svgExport.js), which all need to agree on exactly the same box size.
export const NODE_WIDTH = 170;
export const FULL_LEAF_HEIGHT = 76;
export const FULL_GROUP_HEIGHT = 88;
// Extra box height per wrapped port-badge line beyond the first (wrapPortsLabel/portLines) - a
// container publishing enough ports grows the box to fit them. Read from data('portLines') by
// three places needing the same box size: CY_STYLE height, effectiveBoundingBox, SVG exporter.
export const PORT_EXTRA_LINE_HEIGHT = 10;
export function containerFullHeight(portLines) {
  const extraLines = Math.max(0, (portLines || 0) - 1);
  return FULL_LEAF_HEIGHT + extraLines * PORT_EXTRA_LINE_HEIGHT;
}

// Container node data/classes shared by graph mode (parented to a compose-group box) and tree
// mode (no parent) - factored out so both pick up the same live fields from one place.
// PORT_LABEL_LINE_CHARS: node width minus the port badge's padding, tuned to avoid the fallback wrap.
const PORT_LABEL_LINE_CHARS = 26;

// Ports wrap at whole "host:container" mapping boundaries, never splitting one mapping across
// lines - a broken "800\n1:80" reads far worse than an earlier break. Same idea as wrapPillLabel,
// just token-based since a mapping has no natural mid-token split point worth preferring.
function wrapPortsLabel(text, maxLineChars) {
  const tokens = text.split(', ');
  const lines = [];
  let current = '';
  for (const token of tokens) {
    const candidate = current ? `${current}, ${token}` : token;
    if (current && candidate.length > maxLineChars) {
      lines.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

function containerNodeEl(n, selectedId, parent) {
  const wrappedPorts = wrapPortsLabel(parsePublishedPorts(n.ports), PORT_LABEL_LINE_CHARS);
  const data = {
    id: n.id,
    name: n.name,
    emoji: stateEmoji(n.state),
    status: n.status || '',
    icon: iconFor(n.image, n.composeService),
    cpuPerc: n.cpuPerc,
    memPerc: n.memPerc,
    netIO: formatRatePair(n.netRxRate, n.netTxRate),
    blockIO: formatRatePair(n.blockReadRate, n.blockWriteRate),
    ports: wrappedPorts,
    // Drives the box's own height (see containerFullHeight) - a container publishing enough
    // ports to wrap onto several lines needs a taller box to fit them without overflowing, same
    // principle as tree mode's mount/network pills, just leaf-node height instead of pill height.
    portLines: wrappedPorts ? wrappedPorts.split('\n').length : 0,
    openAlerts: n.openAlerts || 0,
  };
  if (parent) data.parent = parent;
  return {
    data,
    classes:
      (n.state === 'running' ? 'running' : 'stopped') +
      (n.health === 'unhealthy' ? ' unhealthy' : '') +
      (n.id === selectedId ? ' selected' : ''),
  };
}

// containers with this group are treated as having no compose project at all (same sentinel
// docker.js's getTopology already uses for `group` - see there) - a fake "(ungrouped)" project
// node would just be noise, so those containers become their own roots instead.
const NO_PROJECT = 'ungrouped';

// A network shared across projects still comes back as one edge per cross-project container
// pair - two 10-container stacks on one network draw up to 100 crossing lines. Collapses those
// to one edge per project pair (merging network names), since graph mode already boxes projects.
function aggregateNetworkEdges(edges, nodes) {
  const groupOf = new Map(nodes.map((n) => [n.id, n.group]));
  const keyOf = (id) => {
    const g = groupOf.get(id);
    return g && g !== NO_PROJECT ? `grp:${g}` : id;
  };
  const passthrough = [];
  const byPair = new Map(); // "a|b" (sorted) -> { source, target, labels: Set<string> }
  for (const e of edges) {
    if ((e.kind || 'network') !== 'network') {
      passthrough.push(e);
      continue;
    }
    const a = keyOf(e.source);
    const b = keyOf(e.target);
    if (a === b) {
      passthrough.push(e);
      continue;
    }
    const [source, target] = [a, b].sort();
    const pairKey = `${source}|${target}`;
    let agg = byPair.get(pairKey);
    if (!agg) {
      agg = { source, target, labels: new Set() };
      byPair.set(pairKey, agg);
    }
    if (e.label) agg.labels.add(e.label);
  }
  for (const agg of byPair.values()) {
    passthrough.push({ source: agg.source, target: agg.target, kind: 'network', label: [...agg.labels].join(', ') });
  }
  return passthrough;
}

export function buildElements(nodes, edges, selectedId) {
  const groupIds = new Set(nodes.map((n) => n.group));
  const groupAggregates = aggregateGroups(nodes);
  return [
    ...[...groupIds].map((g) => {
      const agg = groupAggregates.get(g);
      return {
        data: {
          id: `grp:${g}`,
          label: g,
          count: agg.count,
          cpuAvg: agg.count ? agg.cpuSum / agg.count : 0,
          memAvg: agg.count ? agg.memSum / agg.count : 0,
          openAlerts: agg.openAlerts,
          health: agg.health,
        },
        classes: 'group',
      };
    }),
    ...nodes.map((n) => containerNodeEl(n, selectedId, `grp:${n.group}`)),
    ...aggregateNetworkEdges(edges, nodes).map((e) => ({
      data: {
        id: `edge:${e.kind || 'network'}:${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        kind: e.kind || 'network',
        label: e.label || '',
      },
      classes: e.kind === 'manual' ? 'edge-manual' : e.kind === 'depends_on' ? 'edge-depends-on' : 'edge-network',
    })),
  ];
}

const MOUNT_LABEL_LINE_CHARS = 22;
// Network pills are a narrower box than mount pills (120px vs 170px) - a shorter line length
// keeps wrapped network names from overflowing them the same way long ones used to.
const NET_LABEL_LINE_CHARS = 14;

// Cytoscape's text-wrap only auto-wraps at whitespace, and mount paths/volume/network names have
// none - a long path is one unbreakable "word" that overflows the pill. Pre-splitting into
// explicit lines at path/word separators is what actually wraps them; CY_STYLE's fallback covers the rest.
function wrapPillLabel(text, maxChars) {
  if (text.length <= maxChars) return text;
  const parts = text.split(/(?<=[/_-])/);
  const lines = [];
  let current = '';
  for (const part of parts) {
    if (current && (current + part).length > maxChars) {
      lines.push(current);
      current = '';
    }
    current += part;
    while (current.length > maxChars) {
      lines.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

function mountLabel(source, kind) {
  // Docker's own anonymous-volume names are the mount's full 64-char id, not a human name -
  // shown shortened so the pill stays readable; the node's own `id` keeps the full source so
  // it's still stable/unique across polls (see buildTreeElements).
  const text = kind === 'volume-anon' ? `anon:${source.slice(0, 12)}…` : source;
  return wrapPillLabel(text, MOUNT_LABEL_LINE_CHARS);
}

// ArgoCD-style tree for tree mode: project -> container -> (network | mount), via the same dagre
// layout graph mode uses but with no compound group boxes. Shared networks/volumes dedupe
// globally (one pill, multiple edges). Node order matters: cy.add() needs pills before edges.
export function buildTreeElements(nodes, selectedId, { showNetworks = true, showMounts = true } = {}) {
  const projectIds = new Set();
  const netNames = new Set();
  // source -> { kind, count } - count is containers referencing it, used to split the mount
  // column into shared-first/unshared-second below (see TREE_LAYOUT's minLen).
  const mountSources = new Map();

  for (const n of nodes) {
    if (n.group && n.group !== NO_PROJECT) projectIds.add(n.group);
    if (showNetworks) for (const net of n.networks || []) netNames.add(net);
    if (showMounts) {
      const seen = new Set();
      for (const m of n.mounts || []) {
        if (seen.has(m.source)) continue;
        seen.add(m.source);
        const existing = mountSources.get(m.source);
        if (existing) existing.count += 1;
        else mountSources.set(m.source, { kind: m.kind, count: 1 });
      }
    }
  }

  const els = [];
  for (const g of projectIds) els.push({ data: { id: `proj:${g}`, label: g }, classes: 'proj' });
  for (const net of netNames) els.push({ data: { id: `net:${net}`, label: wrapPillLabel(net, NET_LABEL_LINE_CHARS) }, classes: 'net' });
  for (const [source, { kind, count }] of mountSources) {
    els.push({
      data: { id: `mount:${source}`, label: mountLabel(source, kind), kind, shared: count > 1 },
      classes: `mount ${kind === 'bind' ? 'mount-bind' : 'mount-volume'}`,
    });
  }

  for (const n of nodes) {
    els.push(containerNodeEl(n, selectedId));
    if (n.group && n.group !== NO_PROJECT) {
      els.push({
        data: { id: `edge:tree:proj:${n.group}->${n.id}`, source: `proj:${n.group}`, target: n.id, kind: 'proj', label: '' },
        classes: 'edge-tree-proj',
      });
    }
    if (showNetworks) {
      for (const net of n.networks || []) {
        els.push({
          data: { id: `edge:tree:${n.id}->net:${net}`, source: n.id, target: `net:${net}`, kind: 'net', label: '' },
          classes: 'edge-tree-net',
        });
      }
    }
    if (showMounts) {
      // Same de-dupe-per-container as the pill-building pass above (one edge per mounted volume,
      // even at two destinations) - without it this emits two edges sharing an id. cy.add()
      // silently drops the second today, but that's incidental; dedupe here is correct by construction.
      const seenMounts = new Set();
      for (const m of n.mounts || []) {
        if (seenMounts.has(m.source)) continue;
        seenMounts.add(m.source);
        els.push({
          data: { id: `edge:tree:${n.id}->mount:${m.source}`, source: n.id, target: `mount:${m.source}`, kind: 'mount', label: '' },
          classes: 'edge-tree-mount',
        });
      }
    }
  }

  return els;
}
