import type {
  CharacterGraph,
  DialogueEdge,
  DialogueNode,
  FieldEntry,
  FieldGroup,
  FieldSection,
  KnowledgeChunk,
  NodeProgressHint,
  NodeRevealChunk,
} from "./types";
import { toCytoscapeElements } from "./cytoscape";
import { validateGraph } from "./validation";

// Game content is canonical JSON (see references/content_json_schema.md). This
// module reads, projects, and edits the parsed object directly — no XML, no DOM.

export interface NodePatchInput {
  title?: string;
  open_text?: string;
  required_nodes_mode?: string;
  required_evidence_mode?: string;
  delivery_style?: string;
  progress_hints?: NodeProgressHint[];
  progress_hint_importance?: string;
}

export interface KnowledgeChunkPatchInput {
  new_chunk_id?: string;
  type?: string;
  active_until?: string;
  text?: string;
}

const BIO_FIELDS = [
  "full_name",
  "age",
  "height",
  "distinguishing_marks",
  "occupation",
  "known_relationships",
  "children",
  "known_skills",
  "hobbies",
  "criminal_record",
] as const;
const VOICE_FIELDS = ["length", "tone", "style", "sample_phrases"] as const;
const PROGRESS_HINT_DEFAULT_IMPORTANCE = "med";
const PROGRESS_HINT_DEFAULT_START_TURNS = 2;
const VALID_PROGRESS_HINT_IMPORTANCES = new Set(["low", "med", "max"]);
const VALID_REQUIRE_MODES = new Set(["none", "all", "any"]);

type Json = Record<string, any>;

function clean(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  return String(value)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function strVal(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitIds(value: string): string[] {
  return value
    .replace(/\+/g, ",")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function cleanMode(value: string): string {
  const cleaned = value.replace("requires:", "").trim().toLowerCase();
  if (cleaned && !VALID_REQUIRE_MODES.has(cleaned))
    throw new Error(`Unsupported requirement mode: ${value}`);
  return cleaned;
}

function cleanChunkType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "fact" && normalized !== "stage")
    throw new Error("Chunk type must be 'fact' or 'stage'");
  return normalized;
}

function cleanImportance(value: string): string {
  const cleaned = value.trim().toLowerCase();
  if (!VALID_PROGRESS_HINT_IMPORTANCES.has(cleaned))
    throw new Error(`Unsupported progress hint importance: ${value}`);
  return cleaned;
}

export class CharacterDocument {
  private data: Json;

  constructor(data: Json) {
    if (typeof data !== "object" || data === null || Array.isArray(data))
      throw new Error("Character file is not a JSON object");
    this.data = data;
  }

  static parse(jsonString: string): CharacterDocument {
    return new CharacterDocument(JSON.parse(jsonString));
  }

  toJson(): Json {
    return this.data;
  }

  serialize(): string {
    return JSON.stringify(this.data, null, 2) + "\n";
  }

  // ── projection ────────────────────────────────────────────────────────────

  toGraph(): CharacterGraph {
    const source = JSON.stringify(this.data);
    const knowledgeChunks = this.knowledgeChunks();
    const chunkById = new Map(knowledgeChunks.map((c) => [c.id, c]));
    const nodeDicts = this.nodes();
    const nodes = nodeDicts
      .filter((n) => strVal(n.id))
      .map((n) => this.projectNode(n, chunkById));
    const sections = this.characterFields().sections;

    const partial: Omit<CharacterGraph, "validation" | "cytoscape"> = {
      character_id: "",
      character_name: strVal(this.data.name),
      source_path: "",
      token_estimate: Math.max(1, Math.floor(source.length / 4)),
      sections,
      knowledge_chunks: knowledgeChunks,
      public_chunk_ids: strList(this.data.public_chunks),
      nodes,
      edges: this.edges(nodeDicts),
      evidence: strList(this.data.evidence_index).map((id) =>
        this.projectEvidence(id, nodeDicts),
      ),
      evidence_catalog: [],
      updates: [],
    };

    const graph = partial as CharacterGraph;
    graph.cytoscape = toCytoscapeElements(graph);
    graph.validation = validateGraph(graph);
    return graph;
  }

  private knowledgeChunks(): KnowledgeChunk[] {
    const chunks: KnowledgeChunk[] = [];
    for (const chunk of (this.data.knowledge_chunks as Json[]) ?? []) {
      const id = strVal(chunk?.id);
      if (!id) continue;
      chunks.push({
        id,
        type: strVal(chunk.type),
        active_until: strVal(chunk.active_until),
        text: clean(chunk.text),
        attrs: {},
        paths: { chunk: `chunks/${id}`, text: `chunks/${id}/text` },
      });
    }
    return chunks;
  }

  private projectNode(
    node: Json,
    chunkById: Map<string, KnowledgeChunk>,
  ): DialogueNode {
    const id = strVal(node.id);
    const open = isObj(node.open) ? node.open : {};
    const requires = isObj(open.requires) ? open.requires : {};
    const reqNodes = isObj(requires.nodes) ? requires.nodes : {};
    const reqEvidence = isObj(requires.evidence) ? requires.evidence : {};
    const progress = isObj(node.progress_hints) ? node.progress_hints : {};
    const gameUpdate = isObj(node.game_update) ? node.game_update : {};

    const revealIds = strList(node.reveals);
    const openedEvidence = strList(gameUpdate.open_evidence);
    const hints = this.projectHints(progress, id);

    return {
      id,
      title: strVal(node.title),
      open_text: clean(open.open_logic),
      required_nodes: strList(reqNodes.ids),
      required_nodes_mode: strVal(reqNodes.mode),
      required_evidence_mode: strVal(reqEvidence.mode),
      required_evidence: strList(reqEvidence.ids),
      opened_evidence: openedEvidence,
      game_updates: openedEvidence.map((eid) => ({ open_evidence: eid })),
      delivery_style: clean(node.delivery_style),
      reveal_chunk_ids: revealIds,
      reveals: revealIds.map((cid) => this.projectReveal(cid, id, chunkById)),
      progress_hint: hints[0]?.text ?? "",
      progress_hint_importance: this.importance(progress.importance),
      progress_hints: hints,
      paths: {
        node: `nodes/${id}`,
        open: `nodes/${id}/open`,
        open_logic: `nodes/${id}/open_logic`,
        reveals: `nodes/${id}/reveals`,
        delivery_style: `nodes/${id}/delivery_style`,
        progress_hints: `nodes/${id}/progress_hints`,
        game_update: `nodes/${id}/game_update`,
      },
    };
  }

  private projectReveal(
    chunkId: string,
    nodeId: string,
    chunkById: Map<string, KnowledgeChunk>,
  ): NodeRevealChunk {
    const chunk = chunkById.get(chunkId);
    const paths: Record<string, string> = {
      reveal: `nodes/${nodeId}/reveals/${chunkId}`,
    };
    if (chunk) Object.assign(paths, chunk.paths);
    return {
      id: chunkId,
      type: chunk?.type ?? "",
      active_until: chunk?.active_until ?? "",
      text: chunk?.text ?? "",
      exists: chunk !== undefined,
      attrs: {},
      paths,
    };
  }

  private projectHints(progress: Json, nodeId: string): NodeProgressHint[] {
    const hints: NodeProgressHint[] = [];
    const list = Array.isArray(progress.hints) ? progress.hints : [];
    list.forEach((hint: Json, index: number) => {
      if (!isObj(hint)) return;
      hints.push({
        text: clean(hint.text),
        starts_after_turns: positiveInt(
          hint.starts_after_turns,
          PROGRESS_HINT_DEFAULT_START_TURNS,
        ),
        paths: { hint: `nodes/${nodeId}/progress_hints/${index}` },
      });
    });
    return hints;
  }

  private importance(value: unknown): "low" | "med" | "max" {
    const cleaned = strVal(value).toLowerCase();
    return (VALID_PROGRESS_HINT_IMPORTANCES.has(cleaned)
      ? cleaned
      : PROGRESS_HINT_DEFAULT_IMPORTANCE) as "low" | "med" | "max";
  }

  private edges(nodeDicts: Json[]): DialogueEdge[] {
    const edges: DialogueEdge[] = [];
    for (const node of nodeDicts) {
      const target = strVal(node.id);
      if (!target) continue;
      const reqNodes = pathGet(node, ["open", "requires", "nodes"]);
      const mode = isObj(reqNodes) ? strVal(reqNodes.mode) : "";
      for (const source of isObj(reqNodes) ? strList(reqNodes.ids) : []) {
        edges.push({
          source,
          target,
          condition: mode ? `requires:${mode}` : "",
          attrs: { source_format: "requires_nodes", mode },
        });
      }
    }
    return edges;
  }

  private projectEvidence(evidenceId: string, nodeDicts: Json[]) {
    const targets: string[] = [];
    for (const node of nodeDicts) {
      const nodeId = strVal(node.id);
      const reqEvidence = pathGet(node, ["open", "requires", "evidence"]);
      const ids = isObj(reqEvidence) ? strList(reqEvidence.ids) : [];
      if (nodeId && ids.includes(evidenceId)) targets.push(nodeId);
    }
    return {
      id: evidenceId,
      name: "",
      status: "",
      power: 1,
      targets,
      meaning: "",
      attrs: {},
      paths: { evidence: `evidence_index/${evidenceId}`, id: `evidence_index/${evidenceId}` },
    };
  }

  // ── character-level field editor ────────────────────────────────────────────

  private characterFields(): {
    sections: FieldSection[];
    accessors: Map<string, { container: Json | any[]; key: string | number }>;
  } {
    const sections: FieldSection[] = [];
    const accessors = new Map<string, { container: Json | any[]; key: string | number }>();

    const field = (
      container: Json | any[],
      key: string | number,
      path: string,
      label: string,
    ): FieldEntry => {
      accessors.set(path, { container, key });
      return { path, label, value: clean((container as any)[key]), tag: label, attrs: {} };
    };

    const profile = isObj(this.data.profile) ? this.data.profile : {};
    const profileGroups: FieldGroup[] = [];

    if ("character_summary" in profile) {
      profileGroups.push({
        id: "profile/character_summary",
        title: "character_summary",
        subtitle: "",
        fields: [
          field(profile, "character_summary", "profile/character_summary", "character_summary"),
        ],
      });
    }

    const voice = isObj(profile.chat_voice) ? profile.chat_voice : null;
    if (voice) {
      const voiceFields: FieldEntry[] = [];
      for (const name of VOICE_FIELDS) {
        if (name in voice) voiceFields.push(field(voice, name, `profile/chat_voice/${name}`, name));
      }
      if (Array.isArray(voice.speech_mechanics)) {
        voice.speech_mechanics.forEach((_: unknown, index: number) => {
          voiceFields.push(
            field(voice.speech_mechanics, index, `profile/chat_voice/speech_mechanics/${index}`, "speech_mechanics"),
          );
        });
      }
      if (voiceFields.length)
        profileGroups.push({ id: "profile/chat_voice", title: "chat_voice", subtitle: "", fields: voiceFields });
    }

    const board = isObj(profile.board_card) ? profile.board_card : null;
    if (board) {
      const boardFields: FieldEntry[] = [];
      for (const name of ["role_type", "display_name", "initials", "relation"]) {
        if (name in board) boardFields.push(field(board, name, `profile/board_card/${name}`, name));
      }
      const bio = isObj(board.bio) ? board.bio : {};
      for (const name of BIO_FIELDS) {
        if (name in bio) boardFields.push(field(bio, name, `profile/board_card/bio/${name}`, `bio / ${name}`));
      }
      if (Array.isArray(board.description)) {
        board.description.forEach((_: unknown, index: number) => {
          boardFields.push(
            field(board.description, index, `profile/board_card/description/${index}`, "description"),
          );
        });
      }
      if (boardFields.length)
        profileGroups.push({ id: "profile/board_card", title: "board_card", subtitle: "", fields: boardFields });
    }

    if (profileGroups.length)
      sections.push({ id: "profile", title: "profile", path: "", groups: profileGroups });

    sections.push({ id: "evidence_index", title: "evidence_index", path: "", groups: [] });

    if ("global_forbidden" in this.data) {
      sections.push({
        id: "global_forbidden",
        title: "global_forbidden",
        path: "",
        groups: [
          {
            id: "global_forbidden",
            title: "Rules",
            subtitle: "",
            fields: [field(this.data, "global_forbidden", "global_forbidden", "global_forbidden")],
          },
        ],
      });
    }

    return { sections, accessors };
  }

  patchField(path: string, value: string): void {
    const { accessors } = this.characterFields();
    const accessor = accessors.get(path);
    if (!accessor) throw new Error(`Field path is not editable: ${path}`);
    (accessor.container as any)[accessor.key] = value;
  }

  // ── node mutators ───────────────────────────────────────────────────────────

  patchNode(nodeId: string, patch: NodePatchInput): void {
    const node = this.findNode(nodeId);
    if (patch.title !== undefined) node.title = patch.title;
    if (patch.open_text !== undefined) this.openBlock(node).open_logic = patch.open_text;
    if (patch.required_nodes_mode !== undefined)
      this.requiresNodes(node).mode = cleanMode(patch.required_nodes_mode);
    if (patch.required_evidence_mode !== undefined)
      this.requiresEvidence(node).mode = cleanMode(patch.required_evidence_mode);
    if (patch.delivery_style !== undefined) node.delivery_style = patch.delivery_style;
    if (patch.progress_hints !== undefined) {
      const block = this.progressHints(node);
      if (patch.progress_hint_importance !== undefined)
        block.importance = cleanImportance(patch.progress_hint_importance);
      else if (!block.importance) block.importance = PROGRESS_HINT_DEFAULT_IMPORTANCE;
      block.hints = patch.progress_hints.map((hint) => ({
        starts_after_turns: positiveInt(hint.starts_after_turns, PROGRESS_HINT_DEFAULT_START_TURNS),
        text: hint.text,
      }));
    } else if (patch.progress_hint_importance !== undefined) {
      this.progressHints(node).importance = cleanImportance(patch.progress_hint_importance);
    }
  }

  deleteNode(nodeId: string): void {
    this.findNode(nodeId);
    for (const other of this.nodes()) {
      const reqNodes = pathGet(other, ["open", "requires", "nodes"]);
      if (isObj(reqNodes) && Array.isArray(reqNodes.ids))
        reqNodes.ids = reqNodes.ids.filter((id: string) => id !== nodeId);
    }
    const raw = this.rawNodes();
    this.disclosureGraph().nodes = raw.filter(
      (n) => !(isObj(n) && strVal(n.id) === nodeId),
    );
  }

  // ── requires.evidence ─────────────────────────────────────────────────────

  addEvidenceRequirement(nodeId: string, evidenceId: string): void {
    appendId(this.requiresEvidence(this.findNode(nodeId)).ids, evidenceId, "Evidence id is required");
  }

  deleteEvidenceRequirement(nodeId: string, evidenceId: string): void {
    removeId(
      this.requiresEvidence(this.findNode(nodeId)).ids,
      evidenceId,
      `Evidence requirement not found: ${nodeId} -> ${evidenceId}`,
    );
  }

  // ── evidence_index ────────────────────────────────────────────────────────

  addEvidenceIndexItem(evidenceId: string): void {
    const id = evidenceId.trim();
    if (!id) throw new Error("Evidence id is required");
    if (!Array.isArray(this.data.evidence_index)) this.data.evidence_index = [];
    if (!this.data.evidence_index.includes(id)) this.data.evidence_index.push(id);
  }

  deleteEvidenceIndexItem(evidenceId: string): void {
    const index = this.data.evidence_index;
    if (!Array.isArray(index) || !index.includes(evidenceId))
      throw new Error(`Evidence index item not found: ${evidenceId}`);
    this.data.evidence_index = index.filter((id: string) => id !== evidenceId);
  }

  renameEvidenceId(oldId: string, newId: string): void {
    const rename = (values: unknown): unknown =>
      Array.isArray(values) ? values.map((v) => (v === oldId ? newId : v)) : values;
    if (Array.isArray(this.data.evidence_index))
      this.data.evidence_index = rename(this.data.evidence_index);
    for (const node of this.nodes()) {
      const reqEvidence = pathGet(node, ["open", "requires", "evidence"]);
      if (isObj(reqEvidence)) reqEvidence.ids = rename(reqEvidence.ids);
      if (isObj(node.game_update))
        node.game_update.open_evidence = rename(node.game_update.open_evidence);
    }
  }

  // ── game_update.open_evidence ─────────────────────────────────────────────

  addGameUpdateOpenEvidence(nodeId: string, itemId: string): void {
    appendId(this.gameUpdateOpenEvidence(this.findNode(nodeId)), itemId, "Game update item id is required");
  }

  deleteGameUpdateOpenEvidence(nodeId: string, itemId: string): void {
    removeId(
      this.gameUpdateOpenEvidence(this.findNode(nodeId)),
      itemId,
      `Game update item not found: ${nodeId} -> ${itemId}`,
    );
  }

  // ── node reveals ──────────────────────────────────────────────────────────

  addNodeReveal(nodeId: string, chunkId: string): void {
    appendId(this.reveals(this.findNode(nodeId)), chunkId, "Chunk id is required");
  }

  deleteNodeReveal(nodeId: string, chunkId: string): void {
    removeId(
      this.reveals(this.findNode(nodeId)),
      chunkId,
      `Reveal chunk not found: ${nodeId} -> ${chunkId}`,
    );
  }

  // ── knowledge chunks ──────────────────────────────────────────────────────

  createKnowledgeChunk(chunkId: string, type: string, text: string, activeUntil?: string): void {
    const id = chunkId.trim();
    if (!id) throw new Error("Chunk id is required");
    if (!Array.isArray(this.data.knowledge_chunks)) this.data.knowledge_chunks = [];
    if (this.data.knowledge_chunks.some((c: Json) => strVal(c?.id) === id))
      throw new Error(`Knowledge chunk already exists: ${id}`);
    const chunk: Json = { id, type: cleanChunkType(type), text };
    const trimmed = (activeUntil ?? "").trim();
    if (trimmed) chunk.active_until = trimmed;
    this.data.knowledge_chunks.push(chunk);
  }

  patchKnowledgeChunk(chunkId: string, patch: KnowledgeChunkPatchInput): void {
    const chunk = this.findChunk(chunkId);
    if (patch.new_chunk_id !== undefined) {
      const newId = patch.new_chunk_id.trim();
      if (!newId) throw new Error("New chunk id is required");
      if (newId !== chunkId && this.chunkExists(newId))
        throw new Error(`Knowledge chunk already exists: ${newId}`);
      this.renameChunkReferences(chunkId, newId);
      chunk.id = newId;
    }
    if (patch.type !== undefined) chunk.type = cleanChunkType(patch.type);
    if (patch.active_until !== undefined) {
      const trimmed = patch.active_until.trim();
      if (trimmed) chunk.active_until = trimmed;
      else delete chunk.active_until;
    }
    if (patch.text !== undefined) chunk.text = patch.text;
  }

  deleteKnowledgeChunk(chunkId: string): void {
    const chunk = this.findChunk(chunkId);
    this.data.knowledge_chunks = (this.data.knowledge_chunks as Json[]).filter((c) => c !== chunk);
    for (const node of this.nodes()) {
      if (Array.isArray(node.reveals))
        node.reveals = node.reveals.filter((id: string) => id !== chunkId);
    }
    if (Array.isArray(this.data.public_chunks))
      this.data.public_chunks = this.data.public_chunks.filter((id: string) => id !== chunkId);
  }

  // ── edges (requires.nodes) ────────────────────────────────────────────────

  addEdge(source: string, target: string, condition?: string): void {
    const block = this.requiresNodes(this.findNode(target));
    if (condition && condition.trim()) block.mode = cleanMode(condition);
    for (const sourceId of splitIds(source)) {
      if (!block.ids.includes(sourceId)) block.ids.push(sourceId);
    }
  }

  patchEdge(
    source: string,
    target: string,
    _condition: string,
    newSource: string,
    newTarget: string,
    newCondition: string,
  ): void {
    this.findNode(newTarget);
    this.removeRequiresEdge(source, target);
    this.addEdge(newSource, newTarget, newCondition);
  }

  deleteEdge(source: string, target: string, _condition = ""): void {
    this.removeRequiresEdge(source, target);
  }

  private removeRequiresEdge(source: string, target: string): void {
    const block = this.requiresNodes(this.findNode(target));
    const sourceIds = new Set(splitIds(source));
    const remaining = block.ids.filter((id: string) => !sourceIds.has(id));
    if (remaining.length === block.ids.length)
      throw new Error(`Edge not found: ${source} -> ${target}`);
    block.ids = remaining;
  }

  // ── private structure helpers ─────────────────────────────────────────────

  private disclosureGraph(): Json {
    if (!isObj(this.data.disclosure_graph)) this.data.disclosure_graph = {};
    if (!Array.isArray(this.data.disclosure_graph.nodes)) this.data.disclosure_graph.nodes = [];
    return this.data.disclosure_graph;
  }

  private rawNodes(): Json[] {
    return this.disclosureGraph().nodes as Json[];
  }

  private nodes(): Json[] {
    return this.rawNodes().filter((n) => isObj(n));
  }

  private findNode(nodeId: string): Json {
    const node = this.nodes().find((n) => strVal(n.id) === nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    return node;
  }

  private findChunk(chunkId: string): Json {
    const chunk = ((this.data.knowledge_chunks as Json[]) ?? []).find(
      (c) => isObj(c) && strVal(c.id) === chunkId,
    );
    if (!chunk) throw new Error(`Knowledge chunk not found: ${chunkId}`);
    return chunk;
  }

  private chunkExists(chunkId: string): boolean {
    return ((this.data.knowledge_chunks as Json[]) ?? []).some(
      (c) => isObj(c) && strVal(c.id) === chunkId,
    );
  }

  private renameChunkReferences(oldId: string, newId: string): void {
    for (const node of this.nodes()) {
      if (Array.isArray(node.reveals))
        node.reveals = node.reveals.map((id: string) => (id === oldId ? newId : id));
    }
    if (Array.isArray(this.data.public_chunks))
      this.data.public_chunks = this.data.public_chunks.map((id: string) => (id === oldId ? newId : id));
  }

  private openBlock(node: Json): Json {
    if (!isObj(node.open)) node.open = {};
    return node.open;
  }

  private requires(node: Json): Json {
    const open = this.openBlock(node);
    if (!isObj(open.requires)) open.requires = {};
    return open.requires;
  }

  private requiresNodes(node: Json): Json {
    const requires = this.requires(node);
    if (!isObj(requires.nodes)) requires.nodes = {};
    if (requires.nodes.mode === undefined) requires.nodes.mode = "all";
    if (!Array.isArray(requires.nodes.ids)) requires.nodes.ids = [];
    return requires.nodes;
  }

  private requiresEvidence(node: Json): Json {
    const requires = this.requires(node);
    if (!isObj(requires.evidence)) requires.evidence = {};
    if (requires.evidence.mode === undefined) requires.evidence.mode = "all";
    if (!Array.isArray(requires.evidence.ids)) requires.evidence.ids = [];
    return requires.evidence;
  }

  private progressHints(node: Json): Json {
    if (!isObj(node.progress_hints)) node.progress_hints = {};
    return node.progress_hints;
  }

  private gameUpdateOpenEvidence(node: Json): string[] {
    if (!isObj(node.game_update)) node.game_update = {};
    if (!Array.isArray(node.game_update.open_evidence)) node.game_update.open_evidence = [];
    return node.game_update.open_evidence;
  }

  private reveals(node: Json): string[] {
    if (!Array.isArray(node.reveals)) node.reveals = [];
    return node.reveals;
  }
}

function isObj(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathGet(data: Json, keys: string[]): unknown {
  let current: unknown = data;
  for (const key of keys) {
    if (!isObj(current)) return undefined;
    current = current[key];
  }
  return current;
}

function appendId(ids: string[], itemId: string, emptyError: string): void {
  const id = (itemId ?? "").trim();
  if (!id) throw new Error(emptyError);
  if (!ids.includes(id)) ids.push(id);
}

function removeId(ids: string[], itemId: string, notFoundError: string): void {
  if (!ids.includes(itemId)) throw new Error(notFoundError);
  const index = ids.indexOf(itemId);
  ids.splice(index, 1);
}
