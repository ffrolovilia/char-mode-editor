import { create } from "zustand";

import type { CharacterGraph, DialogueEdge, DialogueNode } from "./types";
import {
  CharacterXmlDocument,
  type KnowledgeChunkPatchInput,
  type NodePatchInput,
} from "./xml";

type GraphState = {
  fileName: string | null;
  xmlDoc: CharacterXmlDocument | null;
  graph: CharacterGraph | null;
  xml: string;
  selectedId: string | null;
  search: string;
  graphExtrasVisible: boolean;
  loading: boolean;
  error: string | null;

  openFile: () => Promise<void>;
  saveFile: () => void;
  select: (id: string | null) => void;
  setSearch: (search: string) => void;
  toggleGraphExtras: () => void;

  saveXmlField: (path: string, value: string) => Promise<void>;
  deleteXmlField: (path: string) => Promise<void>;
  saveNode: (nodeId: string, patch: Partial<DialogueNode>) => Promise<void>;
  deleteNode: (nodeId: string) => Promise<void>;
  addEdge: (source: string, target: string, condition?: string) => Promise<void>;
  updateEdge: (
    edge: DialogueEdge,
    patch: { source: string; target: string; condition?: string },
  ) => Promise<void>;
  deleteEdge: (edge: DialogueEdge) => Promise<void>;
  addEvidenceRequirement: (nodeId: string, evidenceId: string) => Promise<void>;
  deleteEvidenceRequirement: (nodeId: string, evidenceId: string) => Promise<void>;
  addEvidenceIndexItem: (evidenceId: string) => Promise<void>;
  updateEvidenceIndexItem: (
    evidenceId: string,
    patch: { newEvidenceId?: string },
  ) => Promise<void>;
  deleteEvidenceIndexItem: (evidenceId: string) => Promise<void>;
  addGameUpdateItem: (
    kind: "open-evidence",
    nodeId: string,
    itemId: string,
  ) => Promise<void>;
  deleteGameUpdateItem: (
    kind: "open-evidence",
    nodeId: string,
    itemId: string,
  ) => Promise<void>;
  addNodeReveal: (nodeId: string, chunkId: string) => Promise<void>;
  deleteNodeReveal: (nodeId: string, chunkId: string) => Promise<void>;
  addKnowledgeChunk: (
    chunkId: string,
    type: string,
    text: string,
    activeUntil?: string,
  ) => Promise<void>;
  updateKnowledgeChunk: (
    chunkId: string,
    patch: { newChunkId?: string; type?: string; text?: string; activeUntil?: string },
  ) => Promise<void>;
  deleteKnowledgeChunk: (chunkId: string) => Promise<void>;
};

export const useGraphStore = create<GraphState>((set, get) => ({
  fileName: null,
  xmlDoc: null,
  graph: null,
  xml: "",
  selectedId: null,
  search: "",
  graphExtrasVisible: true,
  loading: false,
  error: null,

  async openFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".xml";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve();
          return;
        }
        set({ loading: true, error: null });
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const xmlString = reader.result as string;
            const xmlDoc = new CharacterXmlDocument(xmlString);
            const graph = xmlDoc.toGraph();
            set({
              fileName: file.name,
              xmlDoc,
              graph,
              xml: xmlString,
              selectedId: null,
              loading: false,
            });
          } catch (err) {
            set({ error: errorMessage(err), loading: false });
          }
          resolve();
        };
        reader.onerror = () => {
          set({ error: "Failed to read file", loading: false });
          resolve();
        };
        reader.readAsText(file, "utf-8");
      };
      input.click();
    });
  },

  saveFile() {
    const { xmlDoc, fileName } = get();
    if (!xmlDoc || !fileName) return;
    const xml = xmlDoc.serialize();
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  },

  select(id) {
    set({ selectedId: id });
  },

  setSearch(search) {
    set({ search });
  },

  toggleGraphExtras() {
    set({ graphExtrasVisible: !get().graphExtrasVisible });
  },

  async saveXmlField(path, value) {
    mutate(get, set, (doc) => doc.patchXmlField(path, value));
  },

  async deleteXmlField(path) {
    mutate(get, set, (doc) => doc.deleteXmlField(path));
  },

  async saveNode(nodeId, patch) {
    mutate(get, set, (doc) =>
      doc.patchNode(nodeId, nodePartialToPatch(patch)),
    );
  },

  async deleteNode(nodeId) {
    mutate(get, set, (doc) => doc.deleteNode(nodeId), { selectedId: null });
  },

  async addEdge(source, target, condition) {
    mutate(get, set, (doc) => doc.addEdge(source, target, condition));
  },

  async updateEdge(edge, patch) {
    mutate(get, set, (doc) =>
      doc.patchEdge(
        edge.source,
        edge.target,
        edge.condition,
        patch.source,
        patch.target,
        patch.condition ?? "",
      ),
    );
  },

  async deleteEdge(edge) {
    mutate(get, set, (doc) =>
      doc.deleteEdge(edge.source, edge.target, edge.condition),
    );
  },

  async addEvidenceRequirement(nodeId, evidenceId) {
    mutate(get, set, (doc) => doc.addEvidenceRequirement(nodeId, evidenceId));
  },

  async deleteEvidenceRequirement(nodeId, evidenceId) {
    mutate(get, set, (doc) =>
      doc.deleteEvidenceRequirement(nodeId, evidenceId),
    );
  },

  async addEvidenceIndexItem(evidenceId) {
    mutate(get, set, (doc) => doc.addEvidenceIndexItem(evidenceId));
  },

  async updateEvidenceIndexItem(evidenceId, patch) {
    // In standalone mode, evidence_id rename only applies within this file
    if (patch.newEvidenceId && patch.newEvidenceId !== evidenceId) {
      mutate(get, set, (doc) => {
        replaceEvidenceIdInDoc(doc, evidenceId, patch.newEvidenceId!);
      });
    }
  },

  async deleteEvidenceIndexItem(evidenceId) {
    mutate(get, set, (doc) => doc.deleteEvidenceIndexItem(evidenceId));
  },

  async addGameUpdateItem(_kind, nodeId, itemId) {
    mutate(get, set, (doc) => doc.addGameUpdateOpenEvidence(nodeId, itemId));
  },

  async deleteGameUpdateItem(_kind, nodeId, itemId) {
    mutate(get, set, (doc) =>
      doc.deleteGameUpdateOpenEvidence(nodeId, itemId),
    );
  },

  async addNodeReveal(nodeId, chunkId) {
    mutate(get, set, (doc) => doc.addNodeReveal(nodeId, chunkId));
  },

  async deleteNodeReveal(nodeId, chunkId) {
    mutate(get, set, (doc) => doc.deleteNodeReveal(nodeId, chunkId));
  },

  async addKnowledgeChunk(chunkId, type, text, activeUntil) {
    mutate(get, set, (doc) =>
      doc.createKnowledgeChunk(chunkId, type, text, activeUntil),
    );
  },

  async updateKnowledgeChunk(chunkId, patch) {
    const kpatch: KnowledgeChunkPatchInput = {
      new_chunk_id: patch.newChunkId,
      type: patch.type,
      active_until: patch.activeUntil,
      text: patch.text,
    };
    mutate(get, set, (doc) => doc.patchKnowledgeChunk(chunkId, kpatch));
  },

  async deleteKnowledgeChunk(chunkId) {
    mutate(get, set, (doc) => doc.deleteKnowledgeChunk(chunkId));
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type StoreGet = () => GraphState;
type StoreSet = (patch: Partial<GraphState>) => void;

function mutate(
  get: StoreGet,
  set: StoreSet,
  fn: (doc: CharacterXmlDocument) => void,
  extra: Partial<GraphState> = {},
): void {
  const { xmlDoc } = get();
  if (!xmlDoc) return;
  try {
    fn(xmlDoc);
    const graph = xmlDoc.toGraph();
    const xml = xmlDoc.serialize();
    set({ graph, xml, error: null, ...extra });
  } catch (err) {
    set({ error: errorMessage(err) });
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function nodePartialToPatch(patch: Partial<DialogueNode>): NodePatchInput {
  return {
    title: patch.title,
    open_text: patch.open_text,
    required_nodes_mode: patch.required_nodes_mode,
    required_evidence_mode: patch.required_evidence_mode,
    must_concede: patch.must_concede,
    can_still_deny: patch.can_still_deny,
    defense_direction: patch.defense_direction,
    tone: patch.tone,
    forbidden: patch.forbidden,
    game_update_xml: patch.game_update_xml,
    progress_hints: patch.progress_hints,
    progress_hint_importance: patch.progress_hint_importance,
  };
}

function replaceEvidenceIdInDoc(
  doc: CharacterXmlDocument,
  oldId: string,
  newId: string,
): void {
  const root = doc.root;
  // Replace in evidence_map/evidence_index id attributes
  for (const ev of Array.from(
    root.querySelectorAll(
      "evidence_map > evidence, evidence_index > evidence",
    ),
  )) {
    if (ev.getAttribute("id") === oldId) ev.setAttribute("id", newId);
  }
  // Replace in node requirements
  for (const ev of Array.from(
    root.querySelectorAll(
      "disclosure_graph nodes node open requires evidence evidence",
    ),
  )) {
    if (ev.getAttribute("id") === oldId) ev.setAttribute("id", newId);
  }
  // Replace in game_update open_evidence children
  for (const ev of Array.from(
    root.querySelectorAll(
      "disclosure_graph nodes node game_update open_evidence evidence",
    ),
  )) {
    if (ev.getAttribute("id") === oldId) ev.setAttribute("id", newId);
  }
  // Replace in game_update open_evidence attribute (legacy)
  for (const gu of Array.from(
    root.querySelectorAll("disclosure_graph nodes node game_update"),
  )) {
    if (gu.getAttribute("open_evidence") === oldId) {
      gu.setAttribute("open_evidence", newId);
    }
  }
}
