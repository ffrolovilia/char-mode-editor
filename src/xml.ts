import type cytoscape from "cytoscape";
import type {
  CharacterGraph,
  DialogueEdge,
  DialogueNode,
  EvidenceCatalogItem,
  EvidenceNode,
  KnowledgeChunk,
  NodeProgressHint,
  NodeRevealChunk,
  ValidationIssue,
  XmlField,
  XmlGroup,
  XmlSection,
} from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_DISCLOSURE_TAGS = ["allowed_disclosure", "must_concede"] as const;
const STILL_HIDDEN_TAGS = ["still_hidden", "can_still_deny"] as const;
const FORBIDDEN_DISCLOSURE_TAGS = ["forbidden_disclosure", "cannot_say"] as const;
const PROGRESS_HINT_DEFAULT_IMPORTANCE = "med";
const PROGRESS_HINT_DEFAULT_START_TURNS = 2;
const VALID_PROGRESS_HINT_IMPORTANCES = new Set(["low", "med", "max"]);

// ─── Patch input types ────────────────────────────────────────────────────────

export interface NodePatchInput {
  title?: string;
  open_text?: string;
  required_nodes_mode?: string;
  required_evidence_mode?: string;
  must_concede?: string;
  can_still_deny?: string;
  defense_direction?: string;
  tone?: string;
  forbidden?: string[];
  game_update_xml?: string;
  progress_hints?: NodeProgressHint[];
  progress_hint_importance?: string;
}

export interface KnowledgeChunkPatchInput {
  new_chunk_id?: string;
  type?: string;
  active_until?: string;
  text?: string;
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function getElementXPath(root: Element, element: Element): string {
  if (element === root) return "/" + root.tagName;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== root) {
    const parentEl: Element | null = current.parentElement;
    if (!parentEl) break;
    const siblings = Array.from(parentEl.children).filter(
      (c: Element) => c.tagName === current!.tagName,
    );
    if (siblings.length > 1) {
      parts.unshift(`/${current.tagName}[${siblings.indexOf(current) + 1}]`);
    } else {
      parts.unshift(`/${current.tagName}`);
    }
    current = parentEl;
  }
  parts.unshift("/" + root.tagName);
  return parts.join("");
}

function xpathAll(contextEl: Element, xpath: string): Element[] {
  const doc = contextEl.ownerDocument!;
  const ctx: Node = xpath.startsWith("/") ? doc : contextEl;
  const result = doc.evaluate(
    xpath,
    ctx,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  const elements: Element[] = [];
  for (let i = 0; i < result.snapshotLength; i++) {
    const node = result.snapshotItem(i);
    if (node instanceof Element) elements.push(node);
  }
  return elements;
}

function xpathFirst(contextEl: Element, xpath: string): Element | null {
  return xpathAll(contextEl, xpath)[0] ?? null;
}

function elementText(el: Element): string {
  let text = "";
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue ?? "";
  }
  return text;
}

function cleanText(value: string): string {
  const lines = value.split("\n").map((l) => l.trim());
  return lines.filter(Boolean).join("\n");
}

function directChildren(parent: Element, tag: string): Element[] {
  return Array.from(parent.children).filter((c) => c.tagName === tag);
}

function directChild(parent: Element, tag: string): Element | null {
  return directChildren(parent, tag)[0] ?? null;
}

function getOrCreate(doc: Document, parent: Element, tag: string): Element {
  const existing = directChild(parent, tag);
  if (existing) return existing;
  const el = doc.createElement(tag);
  parent.appendChild(el);
  return el;
}

function getAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value;
  return attrs;
}

function allDescendantsArr(el: Element): Element[] {
  return Array.from(el.querySelectorAll("*"));
}

function insertAt(parent: Element, child: Element, index: number | null): void {
  if (index === null) {
    parent.appendChild(child);
    return;
  }
  const children = Array.from(parent.children);
  if (index >= children.length) parent.appendChild(child);
  else parent.insertBefore(child, children[index]);
}

// ─── CharacterXmlDocument ─────────────────────────────────────────────────────

export class CharacterXmlDocument {
  private doc: Document;

  constructor(xmlString: string) {
    this.doc = new DOMParser().parseFromString(xmlString, "text/xml");
  }

  get root(): Element {
    return this.doc.documentElement;
  }

  serialize(): string {
    const xml = new XMLSerializer().serializeToString(this.doc);
    if (!xml.startsWith("<?xml")) {
      return '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
    }
    return xml;
  }

  toGraph(): CharacterGraph {
    const root = this.root;
    const knowledgeChunks = this.parseKnowledgeChunks(root);
    const chunkById = new Map(knowledgeChunks.map((c) => [c.id, c]));
    const nodes = xpathAll(root, "./disclosure_graph/nodes/node").map((n) =>
      this.parseNode(n, chunkById),
    );
    const edges = this.parseEdges(root);
    const evidence = xpathAll(
      root,
      "./evidence_map/evidence | ./evidence_index/evidence",
    ).map((e) => this.parseEvidence(e));
    const updates = xpathAll(root, "./game_updates/update").map((u) =>
      this.parseUpdate(u),
    );
    const evidenceCatalog = this.parseEvidenceCatalog(root);
    const sourceXml = this.serialize();

    const partial: Omit<CharacterGraph, "validation" | "cytoscape"> = {
      character_id: root.getAttribute("id") || root.tagName,
      character_name: root.getAttribute("name") || "",
      source_path: "",
      token_estimate: Math.max(1, Math.floor(sourceXml.length / 4)),
      sections: this.parseSections(root),
      knowledge_chunks: knowledgeChunks,
      public_chunk_ids: this.parsePublicChunkIds(root),
      nodes,
      edges,
      evidence,
      evidence_catalog: evidenceCatalog,
      updates,
    };

    const graph = partial as CharacterGraph;
    graph.cytoscape = toCytoscapeElements(graph);
    graph.validation = validateGraph(graph, root);
    return graph;
  }

  // ── public mutations ──────────────────────────────────────────────────────

  patchNode(nodeId: string, patch: NodePatchInput): void {
    const node = this.findNode(nodeId);

    if (patch.title !== undefined) node.setAttribute("title", patch.title);
    this.setNestedChildText(node, ["open"], "open_logic", patch.open_text);
    this.setRequiresMode(node, "nodes", patch.required_nodes_mode);
    this.setRequiresMode(node, "evidence", patch.required_evidence_mode);
    this.setNestedChildTextAlias(
      node,
      ["state_change"],
      ALLOWED_DISCLOSURE_TAGS,
      patch.must_concede,
    );
    this.setNestedChildTextAlias(
      node,
      ["state_change"],
      STILL_HIDDEN_TAGS,
      patch.can_still_deny,
    );
    this.setNestedChildText(
      node,
      ["response_guidance"],
      "defense_direction",
      patch.defense_direction,
    );
    this.setNestedChildText(
      node,
      ["response_guidance"],
      "tone",
      patch.tone,
    );
    if (patch.forbidden !== undefined)
      this.setForbiddenDisclosure(node, patch.forbidden);
    if (patch.game_update_xml !== undefined)
      this.replaceGameUpdateXml(node, patch.game_update_xml);
    if (patch.progress_hints !== undefined) {
      this.replaceProgressHints(
        node,
        patch.progress_hints,
        patch.progress_hint_importance,
      );
    } else if (patch.progress_hint_importance !== undefined) {
      this.setProgressHintImportance(node, patch.progress_hint_importance);
    }
  }

  deleteNode(nodeId: string): void {
    const node = this.findNode(nodeId);
    this.removeNodeReferences(nodeId);
    node.parentElement?.removeChild(node);
  }

  addEdge(source: string, target: string, condition?: string): void {
    if (this.usesRequiresEdges()) {
      this.addRequiresEdge(source, target, condition);
      return;
    }
    const edgesParent = this.findRequired("./disclosure_graph/edges");
    const edge = this.doc.createElement("edge");
    edge.setAttribute("from", source);
    edge.setAttribute("to", target);
    if (condition) edge.setAttribute("condition", condition);
    edgesParent.appendChild(edge);
  }

  patchEdge(
    source: string,
    target: string,
    condition: string,
    newSource: string,
    newTarget: string,
    newCondition: string,
  ): void {
    if (this.usesRequiresEdges()) {
      this.findNode(newTarget);
      this.removeRequiresEdge(source, target);
      this.addRequiresEdge(newSource, newTarget, newCondition);
      return;
    }
    const edge = this.findEdge(source, target, condition);
    edge.setAttribute("from", newSource);
    edge.setAttribute("to", newTarget);
    const cleanCond = newCondition.trim();
    if (cleanCond) edge.setAttribute("condition", cleanCond);
    else edge.removeAttribute("condition");
  }

  deleteEdge(source: string, target: string, condition = ""): void {
    if (this.usesRequiresEdges()) {
      this.removeRequiresEdge(source, target);
      return;
    }
    const edge = this.findEdge(source, target, condition);
    edge.parentElement?.removeChild(edge);
  }

  addEvidenceRequirement(nodeId: string, evidenceId: string): void {
    const parent = this.requiresEvidenceParent(nodeId);
    this.appendChildWithId(parent, "evidence", evidenceId, "Evidence id is required");
  }

  deleteEvidenceRequirement(nodeId: string, evidenceId: string): void {
    const parent = this.requiresEvidenceParent(nodeId);
    this.removeChildWithId(
      parent,
      "evidence",
      evidenceId,
      `Evidence requirement not found: ${nodeId} -> ${evidenceId}`,
    );
  }

  addEvidenceIndexItem(evidenceId: string): void {
    const id = evidenceId.trim();
    if (!id) throw new Error("Evidence id is required");
    if (this.evidenceIndexItemExists(id)) return;
    const parent = this.evidenceIndexParent();
    const child = this.doc.createElement("evidence");
    child.setAttribute("id", id);
    parent.appendChild(child);
  }

  deleteEvidenceIndexItem(evidenceId: string): void {
    const evidence = this.findEvidenceIndexItem(evidenceId);
    evidence.parentElement?.removeChild(evidence);
  }

  addGameUpdateOpenEvidence(nodeId: string, itemId: string): void {
    const parent = this.gameUpdateListParent(nodeId, "open_evidence");
    this.appendChildWithId(
      parent,
      "evidence",
      itemId,
      "Game update item id is required",
    );
  }

  deleteGameUpdateOpenEvidence(nodeId: string, itemId: string): void {
    const parent = this.gameUpdateListParent(nodeId, "open_evidence");
    this.removeChildWithId(
      parent,
      "evidence",
      itemId,
      `Game update item not found: ${nodeId} -> ${itemId}`,
    );
  }

  addNodeReveal(nodeId: string, chunkId: string): void {
    const reveals = this.nodeRevealsParent(nodeId);
    this.appendChildWithId(reveals, "chunk", chunkId, "Chunk id is required");
  }

  deleteNodeReveal(nodeId: string, chunkId: string): void {
    const reveals = this.nodeRevealsParent(nodeId);
    this.removeChildWithId(
      reveals,
      "chunk",
      chunkId,
      `Reveal chunk not found: ${nodeId} -> ${chunkId}`,
    );
  }

  createKnowledgeChunk(
    chunkId: string,
    type: string,
    text: string,
    activeUntil?: string,
  ): void {
    const id = chunkId.trim();
    if (!id) throw new Error("Chunk id is required");
    if (this.knowledgeChunkExists(id))
      throw new Error(`Knowledge chunk already exists: ${id}`);
    const parent = this.knowledgeChunksParent();
    const child = this.doc.createElement("chunk");
    child.setAttribute("id", id);
    child.setAttribute("type", this.cleanChunkType(type));
    const until = (activeUntil || "").trim();
    if (until) child.setAttribute("active_until", until);
    child.textContent = text;
    parent.appendChild(child);
  }

  patchKnowledgeChunk(chunkId: string, patch: KnowledgeChunkPatchInput): void {
    const chunk = this.findKnowledgeChunk(chunkId);
    if (patch.new_chunk_id !== undefined) {
      const newId = patch.new_chunk_id.trim();
      if (!newId) throw new Error("New chunk id is required");
      if (newId !== chunkId && this.knowledgeChunkExists(newId))
        throw new Error(`Knowledge chunk already exists: ${newId}`);
      this.replaceChunkReferences(chunkId, newId);
      chunk.setAttribute("id", newId);
    }
    if (patch.type !== undefined)
      chunk.setAttribute("type", this.cleanChunkType(patch.type));
    if (patch.active_until !== undefined) {
      const until = patch.active_until.trim();
      if (until) chunk.setAttribute("active_until", until);
      else chunk.removeAttribute("active_until");
    }
    if (patch.text !== undefined) chunk.textContent = patch.text;
  }

  deleteKnowledgeChunk(chunkId: string): void {
    const chunk = this.findKnowledgeChunk(chunkId);
    chunk.parentElement?.removeChild(chunk);
    for (const ref of this.matchingChunkReferences(chunkId)) {
      ref.parentElement?.removeChild(ref);
    }
  }

  patchXmlField(path: string, value: string): void {
    this.ensureEditableXmlPath(path, false);
    if (path.includes("/@")) {
      const lastAt = path.lastIndexOf("/@");
      const elementPath = path.slice(0, lastAt);
      const attribute = path.slice(lastAt + 2);
      this.findRequired(elementPath).setAttribute(attribute, value);
    } else {
      this.findRequired(path).textContent = value;
    }
  }

  deleteXmlField(path: string): void {
    this.ensureEditableXmlPath(path, true);
    if (path.includes("/@")) {
      const lastAt = path.lastIndexOf("/@");
      const elementPath = path.slice(0, lastAt);
      const attribute = path.slice(lastAt + 2);
      const el = this.findRequired(elementPath);
      if (!el.hasAttribute(attribute))
        throw new Error(`XML attribute not found: ${path}`);
      el.removeAttribute(attribute);
    } else {
      const el = this.findRequired(path);
      if (!el.parentElement) throw new Error("Cannot delete XML root element");
      el.parentElement.removeChild(el);
    }
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private findNode(nodeId: string): Element {
    const node = xpathAll(this.root, "./disclosure_graph/nodes/node").find(
      (n) => n.getAttribute("id") === nodeId,
    );
    if (!node) throw new Error(`XML node not found: ${nodeId}`);
    return node;
  }

  private findRequired(xpath: string): Element {
    const el = xpathFirst(this.root, xpath);
    if (!el) throw new Error(`XML node not found: ${xpath}`);
    return el;
  }

  private findEdge(source: string, target: string, condition: string): Element {
    const edges = xpathAll(this.root, "./disclosure_graph/edges/edge");
    const edge = edges.find(
      (e) =>
        e.getAttribute("from") === source &&
        e.getAttribute("to") === target &&
        (e.getAttribute("condition") ?? "") === condition,
    );
    if (!edge) throw new Error(`Edge not found: ${source} -> ${target}`);
    return edge;
  }

  private findKnowledgeChunk(chunkId: string): Element {
    const chunk = xpathAll(this.root, "./knowledge_chunks/chunk").find(
      (c) => c.getAttribute("id") === chunkId,
    );
    if (!chunk) throw new Error(`Knowledge chunk not found: ${chunkId}`);
    return chunk;
  }

  private knowledgeChunkExists(chunkId: string): boolean {
    return xpathAll(this.root, "./knowledge_chunks/chunk").some(
      (c) => c.getAttribute("id") === chunkId,
    );
  }

  private findEvidenceIndexItem(evidenceId: string): Element {
    const evidence = xpathAll(
      this.root,
      "./evidence_map/evidence | ./evidence_index/evidence",
    ).find((e) => e.getAttribute("id") === evidenceId);
    if (!evidence)
      throw new Error(`Evidence index item not found: ${evidenceId}`);
    return evidence;
  }

  private evidenceIndexItemExists(evidenceId: string): boolean {
    return xpathAll(
      this.root,
      "./evidence_map/evidence | ./evidence_index/evidence",
    ).some((e) => e.getAttribute("id") === evidenceId);
  }

  private evidenceIndexParent(): Element {
    const existing = directChild(this.root, "evidence_index");
    if (existing) return existing;
    const parent = this.doc.createElement("evidence_index");
    let insertAt = 0;
    Array.from(this.root.children).forEach((child, i) => {
      if (["knowledge_chunks", "public_chunks"].includes(child.tagName))
        insertAt = i + 1;
    });
    const ref = this.root.children[insertAt] ?? null;
    if (ref) this.root.insertBefore(parent, ref);
    else this.root.appendChild(parent);
    return parent;
  }

  private knowledgeChunksParent(): Element {
    const existing = directChild(this.root, "knowledge_chunks");
    if (existing) return existing;
    const parent = this.doc.createElement("knowledge_chunks");
    let insertAt = 0;
    Array.from(this.root.children).forEach((child, i) => {
      if (["profile", "meta"].includes(child.tagName)) insertAt = i + 1;
    });
    const ref = this.root.children[insertAt] ?? null;
    if (ref) this.root.insertBefore(parent, ref);
    else this.root.appendChild(parent);
    return parent;
  }

  private usesRequiresEdges(): boolean {
    return !xpathFirst(this.root, "./disclosure_graph/edges");
  }

  private requiresNodesParent(
    targetId: string,
    mode?: string,
    create = true,
  ): Element | null {
    const targetNode = this.findNode(targetId);
    let requires = xpathFirst(targetNode, "./open/requires");
    if (!requires) {
      if (!create) return null;
      const open = getOrCreate(this.doc, targetNode, "open");
      requires = this.doc.createElement("requires");
      open.appendChild(requires);
    }
    let nodesParent = directChild(requires, "nodes");
    if (!nodesParent) {
      if (!create) return null;
      nodesParent = this.doc.createElement("nodes");
      nodesParent.setAttribute("mode", "all");
      requires.appendChild(nodesParent);
    }
    if (mode !== undefined && mode.trim()) {
      nodesParent.setAttribute("mode", this.cleanConditionMode(mode));
    }
    return nodesParent;
  }

  private requiresEvidenceParent(nodeId: string): Element {
    const targetNode = this.findNode(nodeId);
    let requires = xpathFirst(targetNode, "./open/requires");
    if (!requires) {
      const open = getOrCreate(this.doc, targetNode, "open");
      requires = this.doc.createElement("requires");
      open.appendChild(requires);
    }
    let evidenceParent = directChild(requires, "evidence");
    if (!evidenceParent) {
      evidenceParent = this.doc.createElement("evidence");
      evidenceParent.setAttribute("mode", "all");
      requires.appendChild(evidenceParent);
    }
    return evidenceParent;
  }

  private addRequiresEdge(
    source: string,
    target: string,
    condition?: string,
  ): void {
    const nodesParent = this.requiresNodesParent(target, condition);
    if (!nodesParent)
      throw new Error(`Node requirements not found: ${target}`);
    for (const sourceId of splitIds(source.replace(/\+/g, ","))) {
      if (
        directChildren(nodesParent, "node").some(
          (c) => c.getAttribute("id") === sourceId,
        )
      )
        continue;
      const child = this.doc.createElement("node");
      child.setAttribute("id", sourceId);
      nodesParent.appendChild(child);
    }
  }

  private removeRequiresEdge(source: string, target: string): void {
    const nodesParent = this.requiresNodesParent(target, undefined, false);
    if (!nodesParent)
      throw new Error(`Edge not found: ${source} -> ${target}`);
    const sourceIds = new Set(splitIds(source.replace(/\+/g, ",")));
    let removed = false;
    for (const child of directChildren(nodesParent, "node")) {
      if (sourceIds.has(child.getAttribute("id") ?? "")) {
        nodesParent.removeChild(child);
        removed = true;
      }
    }
    if (!removed) throw new Error(`Edge not found: ${source} -> ${target}`);
  }

  private removeNodeReferences(nodeId: string): void {
    for (const edge of xpathAll(this.root, "./disclosure_graph/edges/edge")) {
      const sourceIds = new Set(
        splitIds((edge.getAttribute("from") ?? "").replace(/\+/g, ",")),
      );
      if (sourceIds.has(nodeId) || edge.getAttribute("to") === nodeId) {
        edge.parentElement?.removeChild(edge);
      }
    }
    for (const reqNode of xpathAll(
      this.root,
      "./disclosure_graph/nodes/node/open/requires/nodes/node",
    )) {
      if (reqNode.getAttribute("id") === nodeId) {
        reqNode.parentElement?.removeChild(reqNode);
      }
    }
  }

  private gameUpdateListParent(nodeId: string, listTag: string): Element {
    const node = this.findNode(nodeId);
    const gameUpdate = getOrCreate(this.doc, node, "game_update");
    return getOrCreate(this.doc, gameUpdate, listTag);
  }

  private nodeRevealsParent(nodeId: string): Element {
    const node = this.findNode(nodeId);
    return getOrCreate(this.doc, node, "reveals");
  }

  private appendChildWithId(
    parent: Element,
    tag: string,
    itemId: string,
    emptyError: string,
  ): void {
    const id = itemId.trim();
    if (!id) throw new Error(emptyError);
    if (
      directChildren(parent, tag).some((c) => c.getAttribute("id") === id)
    )
      return;
    const child = this.doc.createElement(tag);
    child.setAttribute("id", id);
    parent.appendChild(child);
  }

  private removeChildWithId(
    parent: Element,
    tag: string,
    itemId: string,
    notFoundError: string,
  ): void {
    let removed = false;
    for (const child of directChildren(parent, tag)) {
      if (child.getAttribute("id") === itemId) {
        parent.removeChild(child);
        removed = true;
      }
    }
    if (!removed) throw new Error(notFoundError);
  }

  private matchingChunkReferences(chunkId: string): Element[] {
    const refs = xpathAll(this.root, ".//reveals/chunk").filter(
      (c) => c.getAttribute("id") === chunkId,
    );
    refs.push(
      ...xpathAll(this.root, "./public_chunks/chunk").filter(
        (c) => c.getAttribute("id") === chunkId,
      ),
    );
    return refs;
  }

  private replaceChunkReferences(oldId: string, newId: string): void {
    for (const ref of this.matchingChunkReferences(oldId)) {
      ref.setAttribute("id", newId);
    }
  }

  private setRequiresMode(
    node: Element,
    tag: string,
    value: string | undefined,
  ): void {
    if (value === undefined) return;
    const requires = xpathFirst(node, "./open/requires");
    let req = requires;
    if (!req) {
      const open = getOrCreate(this.doc, node, "open");
      req = this.doc.createElement("requires");
      open.appendChild(req);
    }
    const el = getOrCreate(this.doc, req!, tag);
    const cleanVal = this.cleanConditionMode(value);
    if (cleanVal) el.setAttribute("mode", cleanVal);
    else el.removeAttribute("mode");
  }

  private setNestedChildText(
    parent: Element,
    containerTags: string[],
    tag: string,
    value: string | undefined,
  ): void {
    if (value === undefined) return;
    let child = parent.querySelector(tag);
    if (!child) {
      let container = parent;
      for (const ctag of containerTags) {
        container = getOrCreate(this.doc, container, ctag);
      }
      child = this.doc.createElement(tag);
      container.appendChild(child);
    }
    child.textContent = value;
  }

  private setNestedChildTextAlias(
    parent: Element,
    containerTags: string[],
    tags: readonly string[],
    value: string | undefined,
  ): void {
    if (value === undefined) return;
    let child = this.findFirstDescendant(parent, tags);
    if (!child) {
      let container = parent;
      for (const ctag of containerTags) {
        container = getOrCreate(this.doc, container, ctag);
      }
      child = this.doc.createElement(tags[0]);
      container.appendChild(child);
    }
    child.textContent = value;
  }

  private findFirstDescendant(
    parent: Element,
    tags: readonly string[],
  ): Element | null {
    for (const tag of tags) {
      const child = parent.querySelector(tag);
      if (child) return child;
    }
    return null;
  }

  private setForbiddenDisclosure(node: Element, values: string[]): void {
    const text = values.join("\n");
    const existing = this.findFirstDescendant(node, FORBIDDEN_DISCLOSURE_TAGS);
    if (existing) {
      existing.textContent = text;
      return;
    }
    if (directChildren(node, "forbidden").length > 0) {
      for (const c of directChildren(node, "forbidden")) node.removeChild(c);
      for (const v of values) {
        const child = this.doc.createElement("forbidden");
        child.textContent = v;
        node.appendChild(child);
      }
      return;
    }
    this.setNestedChildTextAlias(
      node,
      ["state_change"],
      FORBIDDEN_DISCLOSURE_TAGS,
      text,
    );
  }

  private replaceGameUpdateXml(node: Element, value: string): void {
    for (const gu of directChildren(node, "game_update")) node.removeChild(gu);
    const clean = value.trim();
    if (!clean) return;
    const wrapper = new DOMParser().parseFromString(
      `<wrapper>${clean}</wrapper>`,
      "text/xml",
    );
    if (wrapper.querySelector("parsererror"))
      throw new Error("Invalid game_update XML: parse error");
    for (const child of Array.from(wrapper.documentElement.children)) {
      if (child.tagName !== "game_update")
        throw new Error("game_update XML must contain only <game_update> blocks");
      if (child.querySelector("open_nodes"))
        throw new Error("game_update XML no longer supports <open_nodes>");
      node.appendChild(this.doc.importNode(child, true));
    }
  }

  private setProgressHintImportance(node: Element, importance: string): void {
    const progressHints = getOrCreate(this.doc, node, "progress_hints");
    progressHints.setAttribute(
      "importance",
      this.cleanProgressHintImportance(importance),
    );
  }

  private replaceProgressHints(
    node: Element,
    hints: NodeProgressHint[],
    importance: string | undefined,
  ): void {
    const currentImportance =
      importance !== undefined
        ? importance
        : this.progressHintImportance(node);
    const cleanedImportance = this.cleanProgressHintImportance(
      currentImportance,
      true,
    );

    let insertIndex: number | null = null;
    Array.from(node.children).forEach((child, i) => {
      if (
        ["progress_hints", "progress_hint_if_not_opened"].includes(
          child.tagName,
        ) &&
        insertIndex === null
      )
        insertIndex = i;
    });

    for (const c of directChildren(node, "progress_hints")) node.removeChild(c);
    for (const c of directChildren(node, "progress_hint_if_not_opened"))
      node.removeChild(c);

    const progressHints = this.doc.createElement("progress_hints");
    progressHints.setAttribute("importance", cleanedImportance);
    for (const hint of hints) {
      const child = this.doc.createElement("hint");
      child.setAttribute(
        "starts_after_turns",
        String(positiveInt(hint.starts_after_turns, PROGRESS_HINT_DEFAULT_START_TURNS)),
      );
      child.textContent = hint.text;
      progressHints.appendChild(child);
    }
    insertAt(node, progressHints, insertIndex);
  }

  private progressHintImportance(node: Element): "low" | "med" | "max" {
    const ph = directChild(node, "progress_hints");
    if (!ph) return PROGRESS_HINT_DEFAULT_IMPORTANCE;
    return this.cleanProgressHintImportance(
      ph.getAttribute("importance") ?? "",
      true,
    );
  }

  private cleanProgressHintImportance(
    importance: string,
    allowDefault = false,
  ): "low" | "med" | "max" {
    const cleaned = importance.trim().toLowerCase();
    if (allowDefault && !cleaned) return PROGRESS_HINT_DEFAULT_IMPORTANCE as "low" | "med" | "max";
    if (!VALID_PROGRESS_HINT_IMPORTANCES.has(cleaned))
      throw new Error(`Unsupported progress hint importance: ${importance}`);
    return cleaned as "low" | "med" | "max";
  }

  private cleanConditionMode(value: string): string {
    return value.replace(/^requires:/, "").trim();
  }

  private cleanChunkType(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized !== "fact" && normalized !== "stage")
      throw new Error("Chunk type must be 'fact' or 'stage'");
    return normalized;
  }

  private ensureEditableXmlPath(
    path: string,
    includeContainers: boolean,
  ): void {
    if (!this.editableXmlPaths(includeContainers).has(path))
      throw new Error(`XML path is not editable: ${path}`);
  }

  private editableXmlPaths(includeContainers: boolean): Set<string> {
    const root = this.root;
    const knowledgeChunks = this.parseKnowledgeChunks(root);
    const chunkById = new Map(knowledgeChunks.map((c) => [c.id, c]));
    const paths = new Set<string>();

    for (const node of xpathAll(root, "./disclosure_graph/nodes/node")) {
      const parsed = this.parseNode(node, chunkById);
      for (const field of parsed.xml_fields) paths.add(field.path);
      if (includeContainers) {
        collectPaths(paths, parsed.xml_paths);
        for (const reveal of parsed.reveals) collectPaths(paths, reveal.xml_paths);
      }
    }
    if (includeContainers) {
      for (const chunk of knowledgeChunks) collectPaths(paths, chunk.xml_paths);
      for (const e of xpathAll(root, "./evidence_map/evidence | ./evidence_index/evidence")) {
        collectPaths(paths, this.parseEvidence(e).xml_paths);
      }
    }
    for (const section of this.parseSections(root)) {
      if (includeContainers && section.path) paths.add(section.path);
      for (const group of section.groups) {
        if (includeContainers) paths.add(group.id);
        for (const field of group.fields) paths.add(field.path);
      }
    }
    return paths;
  }

  // ── graph parsing ─────────────────────────────────────────────────────────

  private parseNode(
    node: Element,
    chunkById: Map<string, KnowledgeChunk>,
  ): DialogueNode {
    const root = this.root;
    return {
      id: node.getAttribute("id") ?? "",
      title: node.getAttribute("title") ?? "",
      open_text:
        childText(node, "open_logic") || childText(node, "open"),
      required_nodes: xpathAll(node, "./open/requires/nodes/node")
        .map((n) => n.getAttribute("id") ?? "")
        .filter(Boolean),
      required_nodes_mode: requiresMode(node, "nodes"),
      required_evidence_mode: requiresMode(node, "evidence"),
      must_concede: childTextAny(node, ALLOWED_DISCLOSURE_TAGS),
      can_still_deny: childTextAny(node, STILL_HIDDEN_TAGS),
      defense_direction: legacyResponseText(node, "defense_direction"),
      tone: legacyResponseText(node, "tone"),
      forbidden: [
        ...directChildren(node, "forbidden")
          .map((c) => (c.textContent ?? "").trim())
          .filter(Boolean),
        childTextAny(node, FORBIDDEN_DISCLOSURE_TAGS),
      ].filter(Boolean),
      required_evidence: xpathAll(node, "./open/requires/evidence/evidence")
        .map((e) => e.getAttribute("id") ?? "")
        .filter(Boolean),
      opened_evidence: nodeOpenedEvidence(node),
      game_update_xml: gameUpdateXml(node),
      game_updates: parseNodeGameUpdates(node),
      reveal_chunk_ids: xpathAll(node, "./reveals/chunk")
        .map((c) => c.getAttribute("id") ?? "")
        .filter(Boolean),
      reveals: this.parseNodeReveals(node, chunkById),
      progress_hint: firstProgressHintText(node),
      progress_hint_importance: this.progressHintImportance(node),
      progress_hints: parseProgressHints(node, root),
      xml_fields: this.nodeXmlFields(node),
      attrs: getAttrs(node),
      xml_paths: this.nodeXmlPaths(node),
    };
  }

  private parseKnowledgeChunks(root: Element): KnowledgeChunk[] {
    return xpathAll(root, "./knowledge_chunks/chunk").map((chunk) => {
      const path = getElementXPath(root, chunk);
      const paths: Record<string, string> = { chunk: path, id: `${path}/@id`, text: path };
      if (chunk.hasAttribute("type")) paths["type"] = `${path}/@type`;
      if (chunk.hasAttribute("active_until"))
        paths["active_until"] = `${path}/@active_until`;
      return {
        id: chunk.getAttribute("id") ?? "",
        type: chunk.getAttribute("type") ?? "",
        active_until: chunk.getAttribute("active_until") ?? "",
        text: cleanText(elementText(chunk) || chunk.textContent || ""),
        attrs: getAttrs(chunk),
        xml_paths: paths,
      };
    });
  }

  private parsePublicChunkIds(root: Element): string[] {
    return xpathAll(root, "./public_chunks/chunk")
      .map((c) => c.getAttribute("id") ?? "")
      .filter(Boolean);
  }

  private parseNodeReveals(
    node: Element,
    chunkById: Map<string, KnowledgeChunk>,
  ): NodeRevealChunk[] {
    const root = this.root;
    return xpathAll(node, "./reveals/chunk").map((reveal) => {
      const chunkId = reveal.getAttribute("id") ?? "";
      const chunk = chunkById.get(chunkId);
      const revealPath = getElementXPath(root, reveal);
      const paths: Record<string, string> = {
        reveal: revealPath,
        reveal_id: `${revealPath}/@id`,
      };
      if (chunk) Object.assign(paths, chunk.xml_paths);
      return {
        id: chunkId,
        type: chunk?.type ?? "",
        active_until: chunk?.active_until ?? "",
        text: chunk?.text ?? "",
        exists: !!chunk,
        attrs: chunk ? { ...chunk.attrs } : getAttrs(reveal),
        xml_paths: paths,
      };
    });
  }

  private parseEdges(root: Element): DialogueEdge[] {
    const explicit = xpathAll(root, "./disclosure_graph/edges/edge").map(
      (e): DialogueEdge => ({
        source: e.getAttribute("from") ?? "",
        target: e.getAttribute("to") ?? "",
        condition: e.getAttribute("condition") ?? "",
        attrs: getAttrs(e),
      }),
    );
    if (explicit.length > 0) return explicit;

    const edges: DialogueEdge[] = [];
    for (const node of xpathAll(root, "./disclosure_graph/nodes/node")) {
      const target = node.getAttribute("id") ?? "";
      if (!target) continue;
      const requiresNodes = xpathFirst(node, "./open/requires/nodes");
      if (!requiresNodes) continue;
      const mode = requiresNodes.getAttribute("mode") ?? "";
      for (const sourceNode of directChildren(requiresNodes, "node")) {
        const source = sourceNode.getAttribute("id") ?? "";
        if (!source) continue;
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

  private parseEvidence(evidence: Element): EvidenceNode {
    const root = this.root;
    const evidenceId = evidence.getAttribute("id") ?? "";
    const power = evidence.getAttribute("power") ?? "1";
    const path = getElementXPath(root, evidence);
    const targets = evidenceTargets(evidence, root);
    return {
      id: evidenceId,
      name: evidence.getAttribute("name") ?? evidenceId,
      status: evidence.getAttribute("status") ?? "",
      power: /^\d+$/.test(power) ? parseInt(power, 10) : 1,
      targets,
      meaning: childText(evidence, "meaning"),
      attrs: Object.fromEntries(
        Object.entries(getAttrs(evidence)).filter(([k]) => k !== "source"),
      ),
      xml_paths: { evidence: path, id: `${path}/@id` },
    };
  }

  private parseUpdate(update: Element): Record<string, string> {
    return getAttrs(update);
  }

  private parseEvidenceCatalog(root: Element): EvidenceCatalogItem[] {
    return xpathAll(
      root,
      "./evidence_map/evidence | ./evidence_index/evidence",
    )
      .map((e): EvidenceCatalogItem => {
        const id = e.getAttribute("id") ?? "";
        const status = e.getAttribute("status") ?? "";
        return {
          id,
          title: e.getAttribute("name") || id,
          description: childText(e, "meaning"),
          status,
          available_from_start:
            e.getAttribute("available_from_start") === "true" ||
            status.trim().toLowerCase() === "initial",
        };
      })
      .filter((e) => e.id);
  }

  private parseSections(root: Element): XmlSection[] {
    const sections: XmlSection[] = [];
    const rootGroups = this.rootGroups(root);
    if (rootGroups.length > 0) {
      sections.push({
        id: "character",
        title: "Character",
        path: getElementXPath(root, root),
        groups: rootGroups,
      });
    }

    const sectionSpecs: [string, string, Element | null][] = [
      ["meta", "meta", directChild(root, "meta")],
      ["profile", "profile", directChild(root, "profile")],
      ["public_chunks", "public_chunks", directChild(root, "public_chunks")],
      [
        "disclosure_graph",
        "disclosure_graph",
        directChild(root, "disclosure_graph"),
      ],
      [
        "disclosure_rules",
        "rules",
        xpathFirst(root, "./disclosure_graph/rules"),
      ],
      ["evidence_map", "evidence_map", directChild(root, "evidence_map")],
      ["evidence_index", "evidence_index", directChild(root, "evidence_index")],
      ["game_updates", "game_updates", directChild(root, "game_updates")],
      ["global_forbidden", "global_forbidden", directChild(root, "global_forbidden")],
    ];

    for (const [sectionId, title, element] of sectionSpecs) {
      if (!element) continue;
      const groups = this.sectionGroups(root, element, sectionId);
      if (groups.length > 0) {
        sections.push({
          id: sectionId,
          title,
          path: getElementXPath(root, element),
          groups,
        });
      }
    }
    return sections;
  }

  private rootGroups(root: Element): XmlGroup[] {
    const fields: XmlField[] = Array.from(root.attributes).map((attr) => ({
      path: `${getElementXPath(root, root)}/@${attr.name}`,
      label: attr.name,
      value: attr.value,
      tag: "@attribute",
      attrs: {},
    }));
    if (fields.length === 0) return [];
    return [
      {
        id: getElementXPath(root, root),
        title: "Character Model",
        subtitle: root.tagName,
        fields,
      },
    ];
  }

  private sectionGroups(
    root: Element,
    element: Element,
    sectionId: string,
  ): XmlGroup[] {
    if (sectionId === "meta")
      return [this.groupFromElement(root, element, "Project Model")];
    if (["disclosure_rules", "global_forbidden"].includes(sectionId))
      return [this.groupFromElement(root, element, "Rules")];
    if (sectionId === "disclosure_graph") {
      const groups: XmlGroup[] = [];
      for (const child of Array.from(element.children)) {
        if (["nodes", "edges", "rules"].includes(child.tagName)) continue;
        const group = this.groupFromElement(root, child, groupTitle(child));
        if (group.fields.length > 0) groups.push(group);
      }
      return groups;
    }
    const groups: XmlGroup[] = [];
    for (const child of Array.from(element.children)) {
      const group = this.groupFromElement(root, child, groupTitle(child));
      if (group.fields.length > 0) groups.push(group);
    }
    return groups;
  }

  private groupFromElement(
    root: Element,
    element: Element,
    title: string,
  ): XmlGroup {
    const fields: XmlField[] = [];
    const source = [element, ...allDescendantsArr(element)];
    for (const current of source) {
      fields.push(...this.attributeFields(root, element, current));
      if (["nodes", "edges", "node", "edge"].includes(current.tagName))
        continue;
      const text = cleanText(elementText(current) || current.textContent || "");
      if (!text) continue;
      fields.push({
        path: getElementXPath(root, current),
        label: fieldLabel(element, current),
        value: text,
        tag: current.tagName,
        attrs: getAttrs(current),
      });
    }
    return {
      id: getElementXPath(root, element),
      title,
      subtitle: attrsSubtitle(element),
      fields: dedupeFieldLabels(fields),
    };
  }

  private attributeFields(
    root: Element,
    group: Element,
    element: Element,
  ): XmlField[] {
    return Array.from(element.attributes).map((attr) => ({
      path: `${getElementXPath(root, element)}/@${attr.name}`,
      label:
        element === group
          ? `@${attr.name}`
          : `${fieldLabel(group, element)} / @${attr.name}`,
      value: attr.value,
      tag: "@attribute",
      attrs: {},
    }));
  }

  private nodeXmlPaths(node: Element): Record<string, string> {
    const root = this.root;
    const paths: Record<string, string> = {
      node: getElementXPath(root, node),
    };
    if (node.hasAttribute("title"))
      paths["title"] = `${getElementXPath(root, node)}/@title`;

    const elementSpecs: Record<string, string> = {
      open: "./open",
      open_logic: "./open/open_logic",
      requires: "./open/requires",
      required_nodes: "./open/requires/nodes",
      required_evidence: "./open/requires/evidence",
      state_change: "./state_change",
      response_guidance: "./response_guidance",
      defense_direction: "./response_guidance/defense_direction",
      tone: "./response_guidance/tone",
      game_update: "./game_update",
      open_evidence: "./game_update/open_evidence",
      reveals: "./reveals",
      delivery_style: "./delivery_style",
      progress_hints: "./progress_hints",
      progress_hint_if_not_opened: "./progress_hint_if_not_opened",
    };
    for (const [key, xpath] of Object.entries(elementSpecs)) {
      const el = xpathFirst(node, xpath);
      if (el) paths[key] = getElementXPath(root, el);
    }

    const aliasSpecs: [string, readonly string[]][] = [
      ["must_concede", ALLOWED_DISCLOSURE_TAGS],
      ["can_still_deny", STILL_HIDDEN_TAGS],
      ["cannot_say", FORBIDDEN_DISCLOSURE_TAGS],
    ];
    for (const [key, tags] of aliasSpecs) {
      const el = this.findFirstDescendant(node, tags);
      if (el) paths[key] = getElementXPath(root, el);
    }

    const nodesEl = xpathFirst(node, "./open/requires/nodes");
    if (nodesEl?.hasAttribute("mode"))
      paths["required_nodes_mode"] = `${getElementXPath(root, nodesEl)}/@mode`;
    const evidenceEl = xpathFirst(node, "./open/requires/evidence");
    if (evidenceEl?.hasAttribute("mode"))
      paths["required_evidence_mode"] = `${getElementXPath(root, evidenceEl)}/@mode`;

    return paths;
  }

  private nodeXmlFields(node: Element): XmlField[] {
    const root = this.root;
    const fields: XmlField[] = [];
    const source = [node, ...allDescendantsArr(node)];
    for (const current of source) {
      fields.push(...this.attributeFields(root, node, current));
      if (current === node) continue;
      const text = cleanText(elementText(current) || current.textContent || "");
      if (!text) continue;
      fields.push({
        path: getElementXPath(root, current),
        label: fieldLabel(node, current),
        value: text,
        tag: current.tagName,
        attrs: getAttrs(current),
      });
    }
    return dedupeFieldLabels(fields);
  }
}

// ─── Module-level helpers ─────────────────────────────────────────────────────

function collectPaths(
  paths: Set<string>,
  ...pathMaps: Record<string, string>[]
): void {
  for (const map of pathMaps) {
    for (const v of Object.values(map)) {
      if (v) paths.add(v);
    }
  }
}

function childText(parent: Element, tag: string): string {
  const child = parent.querySelector(tag);
  if (!child) return "";
  return cleanText(elementText(child) || child.textContent || "");
}

function childTextAny(parent: Element, tags: readonly string[]): string {
  for (const tag of tags) {
    const child = parent.querySelector(tag);
    if (child) return cleanText(elementText(child) || child.textContent || "");
  }
  return "";
}

function requiresMode(node: Element, tag: string): string {
  const el = node.querySelector(`open > requires > ${tag}`);
  return el?.getAttribute("mode") ?? "";
}

function legacyResponseText(node: Element, tag: string): string {
  const rg = directChild(node, "response_guidance");
  if (!rg) return "";
  return childText(rg, tag);
}

function nodeOpenedEvidence(node: Element): string[] {
  const opened: string[] = [];
  for (const e of node.querySelectorAll("game_update > open_evidence > evidence")) {
    const id = e.getAttribute("id") ?? "";
    if (id) opened.push(id);
  }
  for (const gu of directChildren(node, "game_update")) {
    const id = (gu.getAttribute("open_evidence") ?? "").trim();
    if (id) opened.push(id);
  }
  return opened;
}

function gameUpdateXml(node: Element): string {
  return directChildren(node, "game_update")
    .map((gu) => new XMLSerializer().serializeToString(gu).trim())
    .filter(Boolean)
    .join("\n");
}

function parseNodeGameUpdates(node: Element): Record<string, string>[] {
  const updates: Record<string, string>[] = [];
  for (const child of directChildren(node, "game_update")) {
    if (child.attributes.length > 0) updates.push(getAttrs(child));
  }
  for (const e of node.querySelectorAll(
    "game_update > open_evidence > evidence",
  )) {
    const id = e.getAttribute("id") ?? "";
    if (id) updates.push({ open_evidence: id });
  }
  return updates;
}

function parseProgressHints(node: Element, root: Element): NodeProgressHint[] {
  const ph = directChild(node, "progress_hints");
  if (ph) {
    return directChildren(ph, "hint").map((hint) => {
      const path = getElementXPath(root, hint);
      return {
        text: cleanText(elementText(hint) || hint.textContent || ""),
        starts_after_turns: positiveInt(
          parseInt(hint.getAttribute("starts_after_turns") ?? "0", 10),
          PROGRESS_HINT_DEFAULT_START_TURNS,
        ),
        xml_paths: {
          hint: path,
          text: path,
          starts_after_turns: `${path}/@starts_after_turns`,
        },
      };
    });
  }
  const legacy = directChild(node, "progress_hint_if_not_opened");
  if (!legacy) return [];
  const path = getElementXPath(root, legacy);
  return [
    {
      text: cleanText(elementText(legacy) || legacy.textContent || ""),
      starts_after_turns: PROGRESS_HINT_DEFAULT_START_TURNS,
      xml_paths: { hint: path, text: path },
    },
  ];
}

function firstProgressHintText(node: Element): string {
  const ph = directChild(node, "progress_hints");
  if (ph) {
    const hint = directChild(ph, "hint");
    return hint
      ? cleanText(elementText(hint) || hint.textContent || "")
      : "";
  }
  const legacy = directChild(node, "progress_hint_if_not_opened");
  return legacy
    ? cleanText(elementText(legacy) || legacy.textContent || "")
    : "";
}

function evidenceTargets(evidence: Element, root: Element): string[] {
  const explicit = splitIds(childText(evidence, "targets"));
  if (explicit.length > 0) return explicit;
  const evidenceId = evidence.getAttribute("id") ?? "";
  if (!evidenceId) return [];
  const targets: string[] = [];
  for (const node of xpathAll(root, "./disclosure_graph/nodes/node")) {
    const nodeId = node.getAttribute("id") ?? "";
    if (!nodeId) continue;
    const required = xpathAll(node, "./open/requires/evidence/evidence").map(
      (e) => e.getAttribute("id") ?? "",
    );
    if (required.includes(evidenceId)) targets.push(nodeId);
  }
  return targets;
}

function groupTitle(element: Element): string {
  const tag = element.tagName;
  if (tag === "node") return element.getAttribute("id") ?? "node";
  if (tag === "evidence") return element.getAttribute("id") ?? "Evidence";
  if (tag === "update")
    return (
      element.getAttribute("open_evidence") ||
      element.getAttribute("trigger") ||
      "Update"
    );
  if (tag === "chunk") return element.getAttribute("id") ?? "chunk";
  if (tag === "defense_strategy")
    return (
      element.getAttribute("name") ||
      element.getAttribute("id") ||
      "Defense Strategy"
    );
  return tag;
}

function fieldLabel(group: Element, field: Element): string {
  if (field === group) return groupTitle(group);
  if (field.parentElement === group) return field.tagName;
  const labels: string[] = [];
  let current: Element | null = field;
  while (current && current !== group) {
    labels.unshift(current.tagName);
    current = current.parentElement;
  }
  return labels.join(" / ");
}

function attrsSubtitle(element: Element): string {
  if (element.attributes.length === 0) return "";
  return Array.from(element.attributes)
    .map((a) => `${a.name}: ${a.value}`)
    .join(" · ");
}

function dedupeFieldLabels(fields: XmlField[]): XmlField[] {
  const totals: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const f of fields) totals[f.label] = (totals[f.label] ?? 0) + 1;
  return fields.map((f) => {
    counts[f.label] = (counts[f.label] ?? 0) + 1;
    if (totals[f.label] > 1) {
      return { ...f, label: `${f.label} ${counts[f.label]}` };
    }
    return f;
  });
}

function splitIds(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function positiveInt(value: number, fallback: number): number {
  return value > 0 ? value : fallback;
}

// ─── Cytoscape layout ─────────────────────────────────────────────────────────

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

// ─── Validation ────────────────────────────────────────────────────────────────

const NODE_ID_PATTERN = /^N\d+$/;
const VALID_REQUIREMENT_MODES = new Set(["", "all", "any", "none"]);
const REQUIRED_NODE_BLOCKS = [
  "open",
  "reveals",
  "delivery_style",
  "progress_hints",
  "game_update",
] as const;

export function validateGraph(
  graph: CharacterGraph,
  xmlRoot: Element,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const evidenceIds = new Set(graph.evidence_catalog.map((e) => e.id));

  issues.push(...validateNodes(graph));
  issues.push(...validateNodeXmlSchema(xmlRoot));
  issues.push(...validateEntryNode(graph, nodeIds, xmlRoot, evidenceIds));
  issues.push(...validateEdges(graph, nodeIds));
  issues.push(...validateRequiredNodes(graph, nodeIds));
  issues.push(...validateRequirementModes(graph));
  issues.push(...validateProgressHints(graph, xmlRoot));
  issues.push(...validateReachability(graph, nodeIds));
  issues.push(...validateCycles(graph, nodeIds));
  issues.push(...validateEvidenceRefs(graph, nodeIds, evidenceIds));
  issues.push(...validateKnowledgeChunks(graph, xmlRoot, nodeIds, evidenceIds));
  issues.push(...validateProgressionOpenability(graph, nodeIds, evidenceIds));
  issues.push(...validateContradictions(graph));

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

function validateNodeXmlSchema(xmlRoot: Element): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of xpathAll(xmlRoot, "./disclosure_graph/nodes/node")) {
    const nodeId = node.getAttribute("id") ?? "";
    const childTags = Array.from(node.children).map((c) => c.tagName);
    const counts = new Map<string, number>();
    for (const tag of childTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);

    for (const block of REQUIRED_NODE_BLOCKS) {
      const count = counts.get(block) ?? 0;
      if (count === 0)
        issues.push({
          severity: "error",
          code: "missing_node_block",
          message: `Node '${nodeId}' is missing required <${block}> block`,
          ref: nodeId,
        });
      else if (count > 1)
        issues.push({
          severity: "error",
          code: "duplicate_node_block",
          message: `Node '${nodeId}' contains duplicate <${block}> blocks`,
          ref: nodeId,
        });
    }
    for (const tag of childTags) {
      if ((REQUIRED_NODE_BLOCKS as readonly string[]).includes(tag)) continue;
      issues.push({
        severity: "error",
        code: "unexpected_node_block",
        message: `Node '${nodeId}' contains unsupported <${tag}> block. Allowed: ${REQUIRED_NODE_BLOCKS.map((b) => `<${b}>`).join(", ")}`,
        ref: nodeId,
      });
    }
  }
  return issues;
}

function validateEntryNode(
  graph: CharacterGraph,
  nodeIds: Set<string>,
  xmlRoot: Element,
  evidenceIds: Set<string>,
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

  const revealChunks = nodeRevealChunkIds(xmlRoot, "N0");
  if (revealChunks.length === 0)
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

function validateProgressHints(
  graph: CharacterGraph,
  xmlRoot: Element,
): ValidationIssue[] {
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
  for (const node of xpathAll(xmlRoot, "./disclosure_graph/nodes/node")) {
    if (
      directChild(node, "progress_hints") &&
      directChild(node, "progress_hint_if_not_opened")
    )
      issues.push({
        severity: "warning",
        code: "mixed_progress_hint_formats",
        message: `Node '${node.getAttribute("id") ?? ""}' contains both legacy and structured progress hints`,
        ref: node.getAttribute("id") ?? "",
      });
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
  xmlRoot: Element,
  nodeIds: Set<string>,
  evidenceIds: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const chunks = knowledgeChunksFromXml(xmlRoot);
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
    const revealIds = nodeRevealChunkIds(xmlRoot, node.id);
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

  for (const chunkId of publicChunkIds(xmlRoot)) {
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
  const { openable } = simulateOpenability(graph, nodeIds, evidenceIds);
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

  const { openable, evidenceAvailable } = simulateOpenability(
    graph,
    nodeIds,
    evidenceIds,
  );

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

function validateContradictions(graph: CharacterGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of graph.nodes) {
    const must = node.must_concede.toLowerCase();
    for (const forbidden of node.forbidden) {
      if (must && forbidden.toLowerCase().includes(must))
        issues.push({
          severity: "warning",
          code: "possible_contradiction",
          message: `Node '${node.id}' allowed disclosure appears inside forbidden rule`,
          ref: node.id,
        });
    }
  }
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
  evidenceIds: Set<string>,
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

function knowledgeChunksFromXml(
  root: Element,
): { id: string; type: string; active_until: string; text: string }[] {
  return xpathAll(root, "./knowledge_chunks/chunk").map((chunk) => ({
    id: (chunk.getAttribute("id") ?? "").trim(),
    type: (chunk.getAttribute("type") ?? "").trim().toLowerCase(),
    active_until: (chunk.getAttribute("active_until") ?? "").trim(),
    text: (elementText(chunk) || chunk.textContent || "").trim(),
  }));
}

function nodeRevealChunkIds(root: Element, nodeId: string): string[] {
  const node = xpathAll(root, "./disclosure_graph/nodes/node").find(
    (n) => (n.getAttribute("id") ?? "").trim() === nodeId,
  );
  if (!node) return [];
  return xpathAll(node, "./reveals/chunk")
    .map((c) => (c.getAttribute("id") ?? "").trim())
    .filter(Boolean);
}

function publicChunkIds(root: Element): string[] {
  return xpathAll(root, "./public_chunks/chunk")
    .map((c) => (c.getAttribute("id") ?? "").trim())
    .filter(Boolean);
}
