import type { CharacterGraph, DialogueNode, ValidationIssue } from "./types";

const NODE_ID_PATTERN = /^N\d+$/;
const VALID_REQUIREMENT_MODES = new Set(["", "all", "any", "none"]);
const VALID_PROGRESS_HINT_IMPORTANCES = new Set(["low", "med", "max"]);

export function validateGraph(graph: CharacterGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const evidenceIds = new Set(graph.evidence_catalog.map((e) => e.id));

  issues.push(...validateNodes(graph));
  issues.push(...validateEntryNode(graph, nodeIds));
  issues.push(...validateEdges(graph, nodeIds));
  issues.push(...validateRequiredNodes(graph, nodeIds));
  issues.push(...validateRequirementModes(graph));
  issues.push(...validateProgressHints(graph));
  issues.push(...validateReachability(graph, nodeIds));
  issues.push(...validateCycles(graph, nodeIds));
  issues.push(...validateEvidenceRefs(graph, nodeIds, evidenceIds));
  issues.push(...validateKnowledgeChunks(graph, nodeIds));
  issues.push(...validateProgressionOpenability(graph, nodeIds, evidenceIds));

  return issues;
}

function validateNodes(graph: CharacterGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    const id = node.id.trim();
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const node of graph.nodes) {
    const id = node.id.trim();
    if (!id) {
      issues.push({ severity: "error", code: "empty_node_id", message: "A dialogue node has an empty id" });
      continue;
    }
    if (!NODE_ID_PATTERN.test(id))
      issues.push({
        severity: "error",
        code: "invalid_node_id",
        message: `Node id '${id}' must use the N<number> format`,
        ref: id,
      });
    if ((counts.get(id) ?? 0) > 1)
      issues.push({
        severity: "error",
        code: "duplicate_node_id",
        message: `Node id '${id}' is duplicated`,
        ref: id,
      });
    if (!node.title.trim())
      issues.push({
        severity: "warning",
        code: "missing_node_title",
        message: `Node '${id}' has no title`,
        ref: id,
      });
  }
  return issues;
}

function validateEntryNode(
  graph: CharacterGraph,
  nodeIds: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!nodeIds.has("N0")) {
    issues.push({
      severity: "error",
      code: "missing_entry_node",
      message: "Entry node N0 is missing",
    });
    return issues;
  }
  const entry = graph.nodes.find((n) => n.id === "N0");
  if (!entry) return issues;

  if (entry.required_nodes.length > 0)
    issues.push({
      severity: "warning",
      code: "entry_requires_nodes",
      message: "Entry node N0 should not require other nodes",
      ref: "N0",
    });

  const startEvidenceIds = starterEvidenceIds(graph);
  const impossible = entry.required_evidence.filter(
    (id) => !startEvidenceIds.has(id),
  );
  if (impossible.length > 0)
    issues.push({
      severity: "error",
      code: "entry_requires_locked_evidence",
      message: `Entry node N0 requires evidence not available at session start: ${impossible.join(", ")}`,
      ref: "N0",
    });

  if (entry.reveal_chunk_ids.length === 0)
    issues.push({
      severity: "error",
      code: "entry_missing_reveals",
      message: "Entry node N0 has no reveals chunks",
      ref: "N0",
    });
  return issues;
}

function validateEdges(
  graph: CharacterGraph,
  nodeIds: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const edge of graph.edges) {
    if (!edge.source.trim())
      issues.push({
        severity: "error",
        code: "empty_edge_source",
        message: `Edge to '${edge.target}' has an empty source`,
        ref: `${edge.source}->${edge.target}`,
      });
    if (!edge.target.trim())
      issues.push({
        severity: "error",
        code: "empty_edge_target",
        message: `Edge from '${edge.source}' has an empty target`,
        ref: `${edge.source}->${edge.target}`,
      });
    for (const source of edgeTokens(edge.source)) {
      if (source === "ANY" || !NODE_ID_PATTERN.test(source)) continue;
      if (!nodeIds.has(source))
        issues.push({
          severity: "error",
          code: "broken_edge_source",
          message: `Edge source '${source}' is missing`,
          ref: `${edge.source}->${edge.target}`,
        });
    }
    for (const target of edgeTokens(edge.target)) {
      if (!NODE_ID_PATTERN.test(target)) continue;
      if (!nodeIds.has(target))
        issues.push({
          severity: "error",
          code: "broken_edge_target",
          message: `Edge target '${target}' is missing`,
          ref: `${edge.source}->${edge.target}`,
        });
    }
  }
  return issues;
}

function validateRequiredNodes(
  graph: CharacterGraph,
  nodeIds: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of graph.nodes) {
    for (const reqId of node.required_nodes) {
      if (!nodeIds.has(reqId))
        issues.push({
          severity: "error",
          code: "missing_required_node",
          message: `Node '${node.id}' requires missing node '${reqId}'`,
          ref: node.id,
        });
    }
  }
  return issues;
}

function validateRequirementModes(graph: CharacterGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of graph.nodes) {
    for (const [field, mode] of [
      ["nodes", node.required_nodes_mode],
      ["evidence", node.required_evidence_mode],
    ] as const) {
      if (!VALID_REQUIREMENT_MODES.has(mode.trim().toLowerCase()))
        issues.push({
          severity: "warning",
          code: "unknown_requirement_mode",
          message: `Node '${node.id}' has unknown ${field} requirement mode '${mode}'`,
          ref: node.id,
        });
    }
  }
  return issues;
}

function validateProgressHints(graph: CharacterGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of graph.nodes) {
    const imp = node.progress_hint_importance.trim().toLowerCase();
    if (!VALID_PROGRESS_HINT_IMPORTANCES.has(imp))
      issues.push({
        severity: "warning",
        code: "unknown_progress_hint_importance",
        message: `Node '${node.id}' has unknown progress hint importance '${node.progress_hint_importance}'`,
        ref: node.id,
      });
    for (const hint of node.progress_hints) {
      if (hint.starts_after_turns <= 0)
        issues.push({
          severity: "warning",
          code: "invalid_progress_hint_turn",
          message: `Node '${node.id}' has a progress hint with a non-positive turn threshold`,
          ref: node.id,
        });
      if (!hint.text.trim())
        issues.push({
          severity: "warning",
          code: "empty_progress_hint",
          message: `Node '${node.id}' has an empty progress hint`,
          ref: node.id,
        });
    }
  }
  return issues;
}

function validateReachability(
  graph: CharacterGraph,
  nodeIds: Set<string>,
): ValidationIssue[] {
  if (!nodeIds.has("N0"))
    return [
      {
        severity: "warning",
        code: "missing_start",
        message: "Start node N0 is missing; dead-node analysis skipped",
      },
    ];
  const adj = buildDialogueAdjacency(graph, nodeIds);
  const reachable = bfsReachable(adj, "N0");
  return [...nodeIds]
    .filter((id) => !reachable.has(id))
    .sort()
    .map((id) => ({
      severity: "warning" as const,
      code: "dead_node",
      message: `Node '${id}' is unreachable from N0`,
      ref: id,
    }));
}

function validateCycles(
  graph: CharacterGraph,
  nodeIds: Set<string>,
): ValidationIssue[] {
  const adj = buildDialogueAdjacency(graph, nodeIds);
  const cycles = findCycles(adj);
  return cycles.map((cycle) => ({
    severity: "warning" as const,
    code: "cycle",
    message: "Dialogue graph contains a cycle: " + cycle.join(" -> "),
    ref: cycle[0] ?? null,
  }));
}

function validateEvidenceRefs(
  graph: CharacterGraph,
  nodeIds: Set<string>,
  evidenceIds: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const evidence of graph.evidence) {
    for (const target of evidence.targets) {
      if (!nodeIds.has(target))
        issues.push({
          severity: "error",
          code: "evidence_missing_target",
          message: `Evidence '${evidence.id}' targets missing node '${target}'`,
          ref: evidence.id,
        });
    }
  }
  for (const node of graph.nodes) {
    for (const evidenceId of node.required_evidence) {
      if (!evidenceIds.has(evidenceId))
        issues.push({
          severity: "error",
          code: "required_evidence_missing",
          message: `Node '${node.id}' requires unknown evidence '${evidenceId}'`,
          ref: node.id,
        });
    }
    for (const match of node.open_text.matchAll(/evidence_id:\s*([a-zA-Z0-9_:-]+)/g)) {
      const id = match[1];
      if (!evidenceIds.has(id))
        issues.push({
          severity: "error",
          code: "open_condition_missing_evidence",
          message: `Node '${node.id}' references unknown evidence '${id}'`,
          ref: node.id,
        });
    }
    for (const update of node.game_updates) {
      const id = update["open_evidence"];
      if (id && !evidenceIds.has(id))
        issues.push({
          severity: "error",
          code: "node_update_missing_evidence",
          message: `Node '${node.id}' opens unknown evidence '${id}'`,
          ref: node.id,
        });
    }
  }
  return issues;
}

function validateKnowledgeChunks(
  graph: CharacterGraph,
  nodeIds: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const chunks = graph.knowledge_chunks.map((c) => ({
    id: c.id.trim(),
    type: c.type.trim().toLowerCase(),
    active_until: c.active_until.trim(),
    text: c.text.trim(),
  }));
  const chunkIds = chunks.map((c) => c.id);
  const chunkCounts = new Map<string, number>();
  for (const id of chunkIds) chunkCounts.set(id, (chunkCounts.get(id) ?? 0) + 1);
  const chunkById = new Map(chunks.filter((c) => c.id).map((c) => [c.id, c]));

  if (chunks.length === 0)
    issues.push({
      severity: "error",
      code: "missing_knowledge_chunks",
      message: "knowledge_chunks is missing or empty",
    });

  for (const chunk of chunks) {
    if (!chunk.id) {
      issues.push({
        severity: "error",
        code: "empty_chunk_id",
        message: "knowledge_chunks contains a chunk without id",
      });
      continue;
    }
    if ((chunkCounts.get(chunk.id) ?? 0) > 1)
      issues.push({
        severity: "error",
        code: "duplicate_chunk_id",
        message: `Knowledge chunk id '${chunk.id}' is duplicated`,
        ref: chunk.id,
      });
    if (!chunk.text)
      issues.push({
        severity: "error",
        code: "empty_chunk_text",
        message: `Knowledge chunk '${chunk.id}' is empty`,
        ref: chunk.id,
      });
    if (!["fact", "stage"].includes(chunk.type))
      issues.push({
        severity: "error",
        code: "invalid_chunk_type",
        message: `Knowledge chunk '${chunk.id}' must have type='fact' or type='stage'`,
        ref: chunk.id,
      });
    if (chunk.type === "stage") {
      if (!chunk.active_until)
        issues.push({
          severity: "error",
          code: "stage_missing_active_until",
          message: `STAGE chunk '${chunk.id}' is missing active_until`,
          ref: chunk.id,
        });
      else if (!nodeIds.has(chunk.active_until))
        issues.push({
          severity: "error",
          code: "stage_active_until_missing_node",
          message: `STAGE chunk '${chunk.id}' active_until references missing node '${chunk.active_until}'`,
          ref: chunk.id,
        });
    }
  }

  const usedChunkIds = new Set<string>();
  const revealNodeByChunk = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const revealIds = node.reveal_chunk_ids;
    if (revealIds.length === 0)
      issues.push({
        severity: "error",
        code: "node_missing_reveals",
        message: `Node '${node.id}' has no reveals chunks`,
        ref: node.id,
      });
    for (const chunkId of revealIds) {
      usedChunkIds.add(chunkId);
      if (!revealNodeByChunk.has(chunkId)) revealNodeByChunk.set(chunkId, []);
      revealNodeByChunk.get(chunkId)!.push(node.id);
      if (!chunkById.has(chunkId))
        issues.push({
          severity: "error",
          code: "node_reveals_missing_chunk",
          message: `Node '${node.id}' reveals missing chunk '${chunkId}'`,
          ref: node.id,
        });
    }
  }

  for (const chunkId of graph.public_chunk_ids) {
    usedChunkIds.add(chunkId);
    if (!chunkById.has(chunkId))
      issues.push({
        severity: "error",
        code: "public_chunk_missing",
        message: `public_chunks references missing chunk '${chunkId}'`,
        ref: chunkId,
      });
  }

  for (const id of [...new Set(chunkIds)].filter(
    (id) => id && !usedChunkIds.has(id),
  ))
    issues.push({
      severity: "warning",
      code: "orphan_chunk",
      message: `Knowledge chunk '${id}' is not used by public_chunks or node/reveals`,
      ref: id,
    });

  const reachAdj = buildReachabilityAdjacency(graph, nodeIds);
  const { openable } = simulateOpenability(graph, nodeIds);
  for (const [chunkId, sourceNodeIds] of revealNodeByChunk) {
    const chunk = chunkById.get(chunkId);
    if (!chunk || chunk.type !== "stage" || !chunk.active_until) continue;
    const activeUntil = chunk.active_until;
    if (!nodeIds.has(activeUntil)) continue;
    for (const sourceNodeId of sourceNodeIds) {
      if (sourceNodeId === activeUntil) continue;
      const reachable = bfsReachable(reachAdj, sourceNodeId);
      if (!reachable.has(activeUntil) && !openable.has(activeUntil))
        issues.push({
          severity: "warning",
          code: "stage_active_until_not_reachable",
          message: `STAGE chunk '${chunkId}' is revealed by '${sourceNodeId}', but active_until '${activeUntil}' is not reachable after it`,
          ref: chunkId,
        });
    }
  }

  return issues;
}

function validateProgressionOpenability(
  graph: CharacterGraph,
  nodeIds: Set<string>,
  evidenceIds: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!nodeIds.has("N0")) return issues;

  const { openable, evidenceAvailable } = simulateOpenability(graph, nodeIds);

  for (const node of graph.nodes) {
    if (!openable.has(node.id))
      issues.push({
        severity: "warning",
        code: "node_never_openable",
        message: `Node '${node.id}' can never open with the current node/evidence prerequisites`,
        ref: node.id,
      });
    for (const evidenceId of node.required_evidence) {
      if (!evidenceIds.has(evidenceId)) continue;
      if (node.opened_evidence.includes(evidenceId))
        issues.push({
          severity: "error",
          code: "node_requires_evidence_it_opens",
          message: `Node '${node.id}' requires evidence '${evidenceId}' that it opens itself`,
          ref: node.id,
        });
    }
  }

  for (const evidenceId of [...evidenceAvailable].filter(
    (id) => !evidenceIds.has(id),
  ).sort())
    issues.push({
      severity: "warning",
      code: "unregistered_unlocked_evidence",
      message: `Graph can unlock evidence '${evidenceId}', but it is not in evidence catalog`,
      ref: evidenceId,
    });

  return issues;
}

// ── Validation helpers ────────────────────────────────────────────────────────

function buildDialogueAdjacency(
  graph: CharacterGraph,
  nodeIds: Set<string>,
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) adj.set(id, new Set());
  for (const edge of graph.edges) {
    const targets = edgeTokens(edge.target).filter((t) => nodeIds.has(t));
    if (targets.length === 0) continue;
    let sources = edgeTokens(edge.source);
    if (sources.includes("ANY"))
      sources = nodeIds.has("N0") ? ["N0"] : [];
    for (const source of sources) {
      if (!nodeIds.has(source)) continue;
      for (const target of targets) adj.get(source)!.add(target);
    }
  }
  return adj;
}

function buildReachabilityAdjacency(
  graph: CharacterGraph,
  nodeIds: Set<string>,
): Map<string, Set<string>> {
  const adj = buildDialogueAdjacency(graph, nodeIds);
  for (const node of graph.nodes) {
    if (!nodeIds.has(node.id)) continue;
    for (const reqId of node.required_nodes) {
      if (!nodeIds.has(reqId)) continue;
      if (!adj.has(reqId)) adj.set(reqId, new Set());
      adj.get(reqId)!.add(node.id);
    }
  }
  return adj;
}

function bfsReachable(
  adj: Map<string, Set<string>>,
  start: string,
): Set<string> {
  const reachable = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (reachable.has(node)) continue;
    reachable.add(node);
    for (const next of adj.get(node) ?? []) {
      if (!reachable.has(next)) queue.push(next);
    }
  }
  return reachable;
}

function findCycles(adj: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const colors = new Map<string, number>();
  const path: string[] = [];

  function dfs(node: string): void {
    colors.set(node, GRAY);
    path.push(node);
    for (const next of adj.get(node) ?? []) {
      const color = colors.get(next) ?? WHITE;
      if (color === GRAY) {
        const start = path.indexOf(next);
        cycles.push(path.slice(start));
      } else if (color === WHITE) {
        dfs(next);
      }
    }
    path.pop();
    colors.set(node, BLACK);
  }

  for (const node of adj.keys()) {
    if ((colors.get(node) ?? WHITE) === WHITE) dfs(node);
  }
  return cycles;
}

function simulateOpenability(
  graph: CharacterGraph,
  nodeIds: Set<string>,
): { openable: Set<string>; evidenceAvailable: Set<string> } {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const incomingEdges = incomingEdgesByTarget(graph, nodeIds);
  const openable = nodeIds.has("N0") ? new Set(["N0"]) : new Set<string>();
  const evidenceAvailable = new Set(starterEvidenceIds(graph));

  for (const nodeId of openable) {
    const node = nodesById.get(nodeId);
    if (node)
      for (const id of node.opened_evidence) evidenceAvailable.add(id);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (openable.has(node.id) || !nodeIds.has(node.id)) continue;
      if (
        !requirementsSatisfied(
          node.required_nodes,
          node.required_nodes_mode,
          openable,
        )
      )
        continue;
      if (
        !requirementsSatisfied(
          node.required_evidence,
          node.required_evidence_mode,
          evidenceAvailable,
        )
      )
        continue;
      if (!hasProgressionSource(node, incomingEdges, openable)) continue;
      openable.add(node.id);
      for (const id of node.opened_evidence) evidenceAvailable.add(id);
      changed = true;
    }
  }
  return { openable, evidenceAvailable };
}

function hasProgressionSource(
  node: DialogueNode,
  incomingEdges: Map<string, Set<string>[]>,
  openable: Set<string>,
): boolean {
  if (node.required_nodes.length > 0 || node.required_evidence.length > 0)
    return true;
  for (const sourceIds of incomingEdges.get(node.id) ?? []) {
    if (sourceIds.has("ANY")) return true;
    if (sourceIds.size > 0 && [...sourceIds].every((s) => openable.has(s)))
      return true;
  }
  return false;
}

function incomingEdgesByTarget(
  graph: CharacterGraph,
  nodeIds: Set<string>,
): Map<string, Set<string>[]> {
  const incoming = new Map<string, Set<string>[]>();
  for (const edge of graph.edges) {
    const targets = edgeTokens(edge.target).filter((t) => nodeIds.has(t));
    if (targets.length === 0) continue;
    const rawSources = new Set(edgeTokens(edge.source));
    const sources: Set<string> = rawSources.has("ANY")
      ? new Set(["ANY"])
      : new Set([...rawSources].filter((s) => nodeIds.has(s)));
    if (sources.size === 0) continue;
    for (const target of targets) {
      if (!incoming.has(target)) incoming.set(target, []);
      incoming.get(target)!.push(sources);
    }
  }
  return incoming;
}

function requirementsSatisfied(
  required: string[],
  mode: string,
  available: Set<string>,
): boolean {
  const req = new Set(required.filter(Boolean));
  if (req.size === 0) return true;
  const normalized = mode.trim().toLowerCase();
  if (normalized === "none")
    return ![...req].some((id) => available.has(id));
  if (normalized === "any") return [...req].some((id) => available.has(id));
  return [...req].every((id) => available.has(id));
}

function starterEvidenceIds(graph: CharacterGraph): Set<string> {
  return new Set(
    graph.evidence_catalog
      .filter((e) => e.available_from_start)
      .map((e) => e.id),
  );
}

function edgeTokens(value: string): string[] {
  return value
    .replace(/,/g, "+")
    .replace(/\|/g, "+")
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
}

