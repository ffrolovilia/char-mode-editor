import type cytoscape from "cytoscape";

import type { CharacterGraph, DialogueEdge, EvidenceNode } from "./types";

const DIALOGUE_X_STEP = 250;
const DIALOGUE_Y_STEP = 180;
const EVIDENCE_X_STEP = 132;
const EVIDENCE_ANCHOR_DISTANCE = 154;
const EVIDENCE_DIAGONAL_X = 148;
const EVIDENCE_DIAGONAL_Y = 124;
const EVIDENCE_NODE_CLEARANCE_X = 166;
const EVIDENCE_NODE_CLEARANCE_Y = 98;
const EVIDENCE_EDGE_CLEARANCE = 74;
const PARKED_EVIDENCE_OFFSET_Y = 230;
const START_X = 140;
const CENTER_Y = 420;
const EVIDENCE_ANCHOR_OFFSETS: [number, number][] = [
  [0, -EVIDENCE_ANCHOR_DISTANCE],
  [0, EVIDENCE_ANCHOR_DISTANCE],
  [-EVIDENCE_ANCHOR_DISTANCE, 0],
  [EVIDENCE_ANCHOR_DISTANCE, 0],
  [-EVIDENCE_DIAGONAL_X, -EVIDENCE_DIAGONAL_Y],
  [EVIDENCE_DIAGONAL_X, -EVIDENCE_DIAGONAL_Y],
  [-EVIDENCE_DIAGONAL_X, EVIDENCE_DIAGONAL_Y],
  [EVIDENCE_DIAGONAL_X, EVIDENCE_DIAGONAL_Y],
];

type Pos = { x: number; y: number };
type CyEl = cytoscape.ElementDefinition;

export function toCytoscapeElements(
  graph: CharacterGraph,
): cytoscape.ElementDefinition[] {
  const elements: CyEl[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const hasAnyEdges = graph.edges.some((e) => e.source === "ANY");
  const positions = narrativePositions(graph);
  const dialogueEdges = expandedDialogueEdges(graph, nodeIds);

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of dialogueEdges) {
    if (nodeIds.has(edge.source))
      outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    if (nodeIds.has(edge.target))
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }

  const openedEvidenceSources = openedEvidenceSourcesMap(graph);

  for (const node of graph.nodes) {
    const classes = ["dialogue"];
    if (!incoming.get(node.id)) classes.push("entry");
    if ((outgoing.get(node.id) ?? 0) > 1) classes.push("branch");
    if (!outgoing.get(node.id)) classes.push("terminal");
    elements.push({
      group: "nodes",
      data: {
        id: node.id,
        label: `${node.id} · ${shortLabel(node.title)}`,
        layer: "dialogue",
        color: "#64748b",
        title: node.title,
      },
      position: positions.get(node.id),
      classes: classes.join(" "),
    });
  }

  for (const evidence of graph.evidence) {
    const classes = ["evidence"];
    if (evidence.targets.length > 0) classes.push("required-evidence");
    if (openedEvidenceSources.has(evidence.id)) classes.push("reward-evidence");
    if (
      evidence.targets.length === 0 &&
      !openedEvidenceSources.has(evidence.id)
    )
      classes.push("parked-evidence");
    elements.push({
      group: "nodes",
      data: {
        id: evidence.id,
        label: evidence.id,
        layer: "evidence",
        color: "#2563eb",
        evidenceId: evidence.id,
        title: evidence.name,
        power: evidence.power,
        size: 26 + evidence.power * 7,
      },
      position: positions.get(evidence.id),
      classes: classes.join(" "),
    });
  }

  if (hasAnyEdges) {
    elements.push({
      group: "nodes",
      data: {
        id: "ANY",
        label: "ANY condition",
        layer: "dialogue",
        color: "#71717a",
      },
      position: positions.get("ANY"),
      classes: "condition",
    });
  }

  const curveDistances = edgeCurveDistances(dialogueEdges, positions);
  for (const edge of dialogueEdges) {
    const raw = edge.edge;
    const classes = ["dialogue-edge"];
    const sp = positions.get(edge.source) ?? { x: 0, y: 0 };
    const tp = positions.get(edge.target) ?? { x: 0, y: 0 };
    const dx = Math.abs(tp.x - sp.x);
    const dy = Math.abs(tp.y - sp.y);
    if (dx <= 260 && dy < 24) classes.push("step-edge");
    if (dx > 300) classes.push("long-edge");
    if (dy >= 40) classes.push("cross-lane-edge");
    if (raw.source === "ANY") classes.push("condition-edge");
    if (raw.source.includes("+") || raw.target.includes("+"))
      classes.push("compound-edge");
    if (raw.condition && !raw.condition.startsWith("requires:"))
      classes.push("conditional-edge");
    const key = `${edge.index}:${edge.source}:${edge.target}`;
    elements.push({
      group: "edges",
      data: {
        id: `edge:${key}`,
        source: edge.source,
        target: edge.target,
        layer: "dialogue",
        condition: raw.condition,
        shortCondition: shortCondition(raw.condition),
        rawSource: raw.source,
        rawTarget: raw.target,
        edgeHint: edgeHint(edge.source, edge.target, raw.condition),
        curveDistance: curveDistances.get(key) ?? 28,
      },
      classes: classes.join(" "),
    });
  }

  for (const evidence of graph.evidence) {
    for (const target of evidence.targets) {
      elements.push({
        group: "edges",
        data: {
          id: `evidence:${evidence.id}:${target}`,
          source: evidence.id,
          target,
          layer: "evidence",
          label: "unlocks/pressures",
          edgeHint: `${evidence.id} required by ${target}`,
        },
        classes: "evidence-edge required-edge",
      });
    }
  }

  for (const node of graph.nodes) {
    for (const update of node.game_updates) {
      const evidenceId = update["open_evidence"];
      if (!evidenceId) continue;
      elements.push({
        group: "edges",
        data: {
          id: `update:${node.id}:${evidenceId}`,
          source: node.id,
          target: evidenceId,
          layer: "updates",
          label: "opens",
          edgeHint: `${node.id} opens ${evidenceId}`,
        },
        classes: "update-edge reward-edge",
      });
    }
  }

  return elements;
}

type ExpandedEdge = {
  index: number;
  source: string;
  target: string;
  edge: DialogueEdge;
};

function expandedDialogueEdges(
  graph: CharacterGraph,
  nodeIds: Set<string>,
): ExpandedEdge[] {
  const edges: ExpandedEdge[] = [];
  graph.edges.forEach((edge, index) => {
    const sources =
      edge.source === "ANY"
        ? ["ANY"]
        : expandEndpoint(edge.source, nodeIds);
    const targets = expandEndpoint(edge.target, nodeIds);
    for (const source of sources)
      for (const target of targets) edges.push({ index, source, target, edge });
  });
  return edges;
}

function expandEndpoint(value: string, nodeIds: Set<string>): string[] {
  return value.split("+").filter((t) => nodeIds.has(t));
}

function edgeCurveDistances(
  dialogueEdges: ExpandedEdge[],
  positions: Map<string, Pos>,
): Map<string, number> {
  const bySource = new Map<string, ExpandedEdge[]>();
  const byTarget = new Map<string, ExpandedEdge[]>();
  for (const edge of dialogueEdges) {
    if (!bySource.has(edge.source)) bySource.set(edge.source, []);
    if (!byTarget.has(edge.target)) byTarget.set(edge.target, []);
    bySource.get(edge.source)!.push(edge);
    byTarget.get(edge.target)!.push(edge);
  }

  const sortFn = (a: ExpandedEdge, b: ExpandedEdge, key: "target" | "source") =>
    (positions.get(a[key])?.y ?? 0) - (positions.get(b[key])?.y ?? 0) ||
    a[key].localeCompare(b[key]);

  for (const edges of bySource.values()) edges.sort((a, b) => sortFn(a, b, "target"));
  for (const edges of byTarget.values()) edges.sort((a, b) => sortFn(a, b, "source"));

  const distances = new Map<string, number>();
  for (const edge of dialogueEdges) {
    const sp = positions.get(edge.source) ?? { x: 0, y: 0 };
    const tp = positions.get(edge.target) ?? { x: 0, y: 0 };
    const dx = tp.x - sp.x;
    const dy = tp.y - sp.y;

    let distance: number;
    if (Math.abs(dy) < 8) {
      distance = Math.abs(dx) <= 230 ? 30 : 112;
    } else {
      distance = -Math.sign(dy) * Math.min(260, Math.max(126, Math.abs(dy * 1.05)));
    }

    const srcEdges = bySource.get(edge.source) ?? [];
    const tgtEdges = byTarget.get(edge.target) ?? [];
    distance += fanOffset(srcEdges, edge, 34) + fanOffset(tgtEdges, edge, 24);

    if (edge.edge.source === "ANY") distance -= 36;
    if (edge.edge.source.includes("+") || edge.edge.target.includes("+"))
      distance += distance >= 0 ? 30 : -30;

    distances.set(`${edge.index}:${edge.source}:${edge.target}`, distance);
  }
  return distances;
}

function fanOffset(edges: ExpandedEdge[], edge: ExpandedEdge, step: number): number {
  if (edges.length <= 1) return 0;
  const index = edges.indexOf(edge);
  const midpoint = (edges.length - 1) / 2;
  return Math.round((index - midpoint) * step);
}

function narrativePositions(graph: CharacterGraph): Map<string, Pos> {
  const positions = new Map<string, Pos>();
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  if (nodeIds.size === 0) return positions;

  const dialogueEdges = expandedDialogueEdges(graph, nodeIds);
  const { adjacency, reverseAdjacency } = buildAdjacency(nodeIds, dialogueEdges);
  const ranks = nodeRanks(nodeIds, dialogueEdges);
  const primaryPath = buildPrimaryPath(nodeIds, adjacency, reverseAdjacency, ranks);
  const lanes = nodeLanes(nodeIds, ranks, primaryPath, adjacency, reverseAdjacency);

  const sortedNodeIds = [...nodeIds].sort(
    (a, b) =>
      (ranks.get(a) ?? 0) - (ranks.get(b) ?? 0) ||
      nodeIndex(a) - nodeIndex(b) ||
      a.localeCompare(b),
  );
  for (const nodeId of sortedNodeIds) {
    positions.set(nodeId, {
      x: START_X + (ranks.get(nodeId) ?? 0) * DIALOGUE_X_STEP,
      y: CENTER_Y + (lanes.get(nodeId) ?? 0) * DIALOGUE_Y_STEP,
    });
  }

  if (graph.edges.some((e) => e.source === "ANY")) {
    positions.set("ANY", { x: START_X - 46, y: CENTER_Y + DIALOGUE_Y_STEP });
  }

  const openedSources = openedEvidenceSourcesMap(graph);
  const usedPoints = new Set<string>();
  const requiredGroups = new Map<string, EvidenceNode[]>();
  const rewardGroups = new Map<string, EvidenceNode[]>();
  const parkedEvidence: EvidenceNode[] = [];

  for (const evidence of graph.evidence) {
    const targets = evidence.targets
      .filter((t) => positions.has(t))
      .join(",");
    const sources = (openedSources.get(evidence.id) ?? [])
      .filter((s) => positions.has(s))
      .join(",");
    if (targets) {
      if (!requiredGroups.has(targets)) requiredGroups.set(targets, []);
      requiredGroups.get(targets)!.push(evidence);
    } else if (sources) {
      if (!rewardGroups.has(sources)) rewardGroups.set(sources, []);
      rewardGroups.get(sources)!.push(evidence);
    } else {
      parkedEvidence.push(evidence);
    }
  }

  const dialoguePositions = new Map(
    [...positions.entries()].filter(([id]) => nodeIds.has(id)),
  );

  for (const [targetsKey, group] of requiredGroups) {
    const targetList = targetsKey.split(",").filter(Boolean);
    placeLinkedEvidenceGroup(
      positions,
      group,
      targetList,
      dialoguePositions,
      usedPoints,
      (e) =>
        `${nodeIndex(e.targets[0] ?? "").toString().padStart(8, "0")}:${e.id}`,
    );
  }
  for (const [sourcesKey, group] of rewardGroups) {
    const sourceList = sourcesKey.split(",").filter(Boolean);
    placeLinkedEvidenceGroup(
      positions,
      group,
      sourceList,
      dialoguePositions,
      usedPoints,
      (e) => e.id,
    );
  }

  let dialogueBottom = CENTER_Y;
  for (const [id, pos] of positions) {
    if (nodeIds.has(id) && pos.y > dialogueBottom) dialogueBottom = pos.y;
  }
  placeEvidenceGroup(
    positions,
    parkedEvidence,
    START_X,
    dialogueBottom + PARKED_EVIDENCE_OFFSET_Y,
    usedPoints,
    (e) => e.id,
    true,
  );

  return positions;
}

function placeLinkedEvidenceGroup(
  positions: Map<string, Pos>,
  group: EvidenceNode[],
  linkedIds: string[],
  dialoguePositions: Map<string, Pos>,
  usedPoints: Set<string>,
  sortKey: (e: EvidenceNode) => string,
): void {
  const linkedPositions = linkedIds
    .map((id) => dialoguePositions.get(id))
    .filter((p): p is Pos => !!p);
  if (linkedPositions.length === 0) {
    placeEvidenceGroup(
      positions,
      group,
      START_X,
      CENTER_Y,
      usedPoints,
      sortKey,
    );
    return;
  }
  const center = {
    x: linkedPositions.reduce((s, p) => s + p.x, 0) / linkedPositions.length,
    y: linkedPositions.reduce((s, p) => s + p.y, 0) / linkedPositions.length,
  };
  const ordered = [...group].sort((a, b) =>
    sortKey(a).localeCompare(sortKey(b)),
  );
  const bestOffset = EVIDENCE_ANCHOR_OFFSETS.reduce((best, offset) => {
    const bScore = evidenceGroupScore(
      evidenceGroupCandidatePoints(center, best, ordered.length),
      linkedPositions,
      dialoguePositions,
      usedPoints,
    );
    const oScore = evidenceGroupScore(
      evidenceGroupCandidatePoints(center, offset, ordered.length),
      linkedPositions,
      dialoguePositions,
      usedPoints,
    );
    return oScore < bScore ? offset : best;
  });
  const points = evidenceGroupCandidatePoints(center, bestOffset, ordered.length);
  for (let i = 0; i < ordered.length; i++) {
    positions.set(
      ordered[i].id,
      unusedEvidencePoint(points[i], usedPoints, dialoguePositions),
    );
  }
}

function evidenceGroupCandidatePoints(
  center: Pos,
  offset: [number, number],
  count: number,
): Pos[] {
  const anchor = { x: center.x + offset[0], y: center.y + offset[1] };
  const midpoint = (count - 1) / 2;
  const spreadOnX = Math.abs(offset[1]) >= Math.abs(offset[0]);
  return Array.from({ length: count }, (_, i) => ({
    x: anchor.x + (spreadOnX ? (i - midpoint) * EVIDENCE_X_STEP : 0),
    y: anchor.y + (spreadOnX ? 0 : (i - midpoint) * 72),
  }));
}

function evidenceGroupScore(
  points: Pos[],
  linkedPositions: Pos[],
  dialoguePositions: Map<string, Pos>,
  usedPoints: Set<string>,
): number {
  let score = 0;
  for (const point of points) {
    score += occupiedPointScore(point, usedPoints);
    for (const np of dialoguePositions.values()) score += nodeProximityScore(point, np);
    for (const lp of linkedPositions) {
      for (const np of dialoguePositions.values()) {
        if (np === lp) continue;
        score += segmentProximityScore(point, lp, np);
      }
    }
  }
  return score;
}

function occupiedPointScore(point: Pos, usedPoints: Set<string>): number {
  const key = pointKey(point);
  if (usedPoints.has(key)) return 1000;
  const [kx, ky] = key.split(":").map(Number);
  let near = 0;
  for (const used of usedPoints) {
    const [ux, uy] = used.split(":").map(Number);
    if (Math.abs(ux - kx) <= 3 && Math.abs(uy - ky) <= 3) near++;
  }
  return near * 18;
}

function nodeProximityScore(point: Pos, nodePos: Pos): number {
  const dx = Math.abs(point.x - nodePos.x);
  const dy = Math.abs(point.y - nodePos.y);
  if (dx >= EVIDENCE_NODE_CLEARANCE_X || dy >= EVIDENCE_NODE_CLEARANCE_Y) return 0;
  return 120 + ((EVIDENCE_NODE_CLEARANCE_X - dx) / EVIDENCE_NODE_CLEARANCE_X) * 30;
}

function segmentProximityScore(source: Pos, target: Pos, nodePos: Pos): number {
  const dist = pointToSegmentDistance(nodePos, source, target);
  if (dist >= EVIDENCE_EDGE_CLEARANCE) return 0;
  return 50 + ((EVIDENCE_EDGE_CLEARANCE - dist) / EVIDENCE_EDGE_CLEARANCE) * 80;
}

function pointToSegmentDistance(point: Pos, source: Pos, target: Pos): number {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0)
    return Math.hypot(point.x - source.x, point.y - source.y);
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - source.x) * dx + (point.y - source.y) * dy) / lenSq,
    ),
  );
  const nearest = { x: source.x + t * dx, y: source.y + t * dy };
  return Math.hypot(point.x - nearest.x, point.y - nearest.y);
}

function placeEvidenceGroup(
  positions: Map<string, Pos>,
  group: EvidenceNode[],
  anchorX: number,
  anchorY: number,
  usedPoints: Set<string>,
  sortKey: (e: EvidenceNode) => string,
  alignLeft = false,
): void {
  const ordered = [...group].sort((a, b) =>
    sortKey(a).localeCompare(sortKey(b)),
  );
  const midpoint = alignLeft ? 0 : (ordered.length - 1) / 2;
  for (let i = 0; i < ordered.length; i++) {
    const x = anchorX + (i - midpoint) * EVIDENCE_X_STEP;
    positions.set(ordered[i].id, unusedPoint(x, anchorY, usedPoints));
  }
}

function buildAdjacency(
  nodeIds: Set<string>,
  dialogueEdges: ExpandedEdge[],
): {
  adjacency: Map<string, string[]>;
  reverseAdjacency: Map<string, string[]>;
} {
  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
    reverseAdjacency.set(id, []);
  }
  for (const edge of dialogueEdges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const adj = adjacency.get(edge.source)!;
    if (!adj.includes(edge.target)) adj.push(edge.target);
    const rev = reverseAdjacency.get(edge.target)!;
    if (!rev.includes(edge.source)) rev.push(edge.source);
  }
  const cmp = (a: string, b: string) => nodeIndex(a) - nodeIndex(b) || a.localeCompare(b);
  for (const v of adjacency.values()) v.sort(cmp);
  for (const v of reverseAdjacency.values()) v.sort(cmp);
  return { adjacency, reverseAdjacency };
}

function nodeRanks(
  nodeIds: Set<string>,
  dialogueEdges: ExpandedEdge[],
): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const id of nodeIds) ranks.set(id, 0);
  const maxIter = Math.max(1, nodeIds.size);
  for (let i = 0; i < maxIter; i++) {
    let changed = false;
    for (const edge of dialogueEdges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      const candidate = (ranks.get(edge.source) ?? 0) + 1;
      if (candidate > (ranks.get(edge.target) ?? 0)) {
        ranks.set(edge.target, candidate);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return ranks;
}

function buildPrimaryPath(
  nodeIds: Set<string>,
  adjacency: Map<string, string[]>,
  reverseAdjacency: Map<string, string[]>,
  ranks: Map<string, number>,
): string[] {
  const starts = [...nodeIds].filter(
    (id) => (reverseAdjacency.get(id) ?? []).length === 0,
  );
  const cmp = (a: string, b: string) => nodeIndex(a) - nodeIndex(b) || a.localeCompare(b);
  let current = starts.sort(cmp)[0] ?? [...nodeIds].sort(cmp)[0];
  const path: string[] = [];
  const visited = new Set<string>();

  while (current && !visited.has(current)) {
    path.push(current);
    visited.add(current);
    const candidates = (adjacency.get(current) ?? []).filter(
      (t) => !visited.has(t) && (ranks.get(t) ?? 0) > (ranks.get(current) ?? 0),
    );
    if (candidates.length === 0) break;
    const curIdx = nodeIndex(current);
    candidates.sort((a, b) => {
      const aIdx = nodeIndex(a);
      const bIdx = nodeIndex(b);
      return (
        (aIdx === curIdx + 1 ? 0 : 1) - (bIdx === curIdx + 1 ? 0 : 1) ||
        Math.abs(aIdx - curIdx) - Math.abs(bIdx - curIdx) ||
        (ranks.get(a) ?? 0) - (ranks.get(b) ?? 0) ||
        aIdx - bIdx ||
        a.localeCompare(b)
      );
    });
    current = candidates[0];
  }
  return path;
}

function nodeLanes(
  nodeIds: Set<string>,
  ranks: Map<string, number>,
  primaryPath: string[],
  adjacency: Map<string, string[]>,
  reverseAdjacency: Map<string, string[]>,
): Map<string, number> {
  const lanes = new Map<string, number>();
  const occupied = new Map<number, Set<number>>();

  for (const nodeId of primaryPath) {
    const rank = ranks.get(nodeId) ?? 0;
    lanes.set(nodeId, 0);
    if (!occupied.has(rank)) occupied.set(rank, new Set());
    occupied.get(rank)!.add(0);
  }

  const primarySet = new Set(primaryPath);
  const remaining = [...nodeIds]
    .filter((id) => !primarySet.has(id))
    .sort(
      (a, b) =>
        (ranks.get(a) ?? 0) - (ranks.get(b) ?? 0) ||
        nodeIndex(a) - nodeIndex(b) ||
        a.localeCompare(b),
    );

  for (const nodeId of remaining) {
    const rank = ranks.get(nodeId) ?? 0;
    const predLanes = (reverseAdjacency.get(nodeId) ?? [])
      .filter((s) => lanes.has(s))
      .map((s) => lanes.get(s)!);
    const succLanes = (adjacency.get(nodeId) ?? [])
      .filter((t) => lanes.has(t))
      .map((t) => lanes.get(t)!);
    const preferred =
      predLanes[0] !== undefined
        ? predLanes[0]
        : succLanes[0] !== undefined
          ? succLanes[0]
          : 0;
    if (!occupied.has(rank)) occupied.set(rank, new Set());
    const lane = nearestFreeLane(preferred, occupied.get(rank)!);
    lanes.set(nodeId, lane);
    occupied.get(rank)!.add(lane);
  }
  return lanes;
}

function nearestFreeLane(preferred: number, occupied: Set<number>): number {
  for (const candidate of [preferred, -1, 1, -2, 2, -3, 3, -4, 4, 0]) {
    if (!occupied.has(candidate)) return candidate;
  }
  let lane = 5;
  while (occupied.has(lane)) lane++;
  return lane;
}

function openedEvidenceSourcesMap(
  graph: CharacterGraph,
): Map<string, string[]> {
  const sources = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const evidenceId of node.opened_evidence) {
      if (!sources.has(evidenceId)) sources.set(evidenceId, []);
      if (!sources.get(evidenceId)!.includes(node.id))
        sources.get(evidenceId)!.push(node.id);
    }
    for (const update of node.game_updates) {
      const evidenceId = update["open_evidence"];
      if (!evidenceId) continue;
      if (!sources.has(evidenceId)) sources.set(evidenceId, []);
      if (!sources.get(evidenceId)!.includes(node.id))
        sources.get(evidenceId)!.push(node.id);
    }
  }
  return sources;
}

function unusedPoint(
  x: number,
  y: number,
  usedPoints: Set<string>,
): Pos {
  const point = { x, y };
  let key = pointKey(point);
  while (usedPoints.has(key)) {
    point.y += 72;
    key = pointKey(point);
  }
  usedPoints.add(key);
  return { ...point };
}

function unusedEvidencePoint(
  point: Pos,
  usedPoints: Set<string>,
  dialoguePositions: Map<string, Pos>,
): Pos {
  const attempts: [number, number][] = [
    [0, 0],
    [0, 72],
    [0, -72],
    [72, 0],
    [-72, 0],
    [72, 72],
    [-72, -72],
  ];
  let candidate = { ...point };
  for (const [dx, dy] of attempts) {
    candidate = { x: point.x + dx, y: point.y + dy };
    if (usedPoints.has(pointKey(candidate))) continue;
    if (
      [...dialoguePositions.values()].every(
        (np) => nodeProximityScore(candidate, np) === 0,
      )
    )
      break;
  }
  usedPoints.add(pointKey(candidate));
  return candidate;
}

function pointKey(point: Pos): string {
  return `${Math.round(point.x / 24)}:${Math.round(point.y / 24)}`;
}

function nodeIndex(nodeId: string): number {
  if (/^N\d+$/.test(nodeId)) return parseInt(nodeId.slice(1), 10);
  return 10000;
}

function shortLabel(value: string, limit = 24): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit - 1).trimEnd() + "…";
}

function shortCondition(value: string): string {
  if (!value || value.startsWith("requires:")) return "";
  return shortLabel(value, 30);
}

function edgeHint(source: string, target: string, condition: string): string {
  const cond = shortCondition(condition);
  return cond ? `${source} -> ${target} · ${cond}` : `${source} -> ${target}`;
}

