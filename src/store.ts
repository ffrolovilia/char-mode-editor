import { create } from "zustand";

import type {
  CharacterGraph,
  DialogueEdge,
  DialogueNode,
  EvidenceCatalogItem,
} from "./types";
import {
  CharacterDocument,
  type KnowledgeChunkPatchInput,
  type NodePatchInput,
} from "./document";

type GraphState = {
  fileName: string | null;
  doc: CharacterDocument | null;
  graph: CharacterGraph | null;
  source: string;
  selectedId: string | null;
  search: string;
  graphExtrasVisible: boolean;
  loading: boolean;
  error: string | null;
  evidenceCatalog: EvidenceCatalogItem[];
  evidenceFileName: string | null;

  openFile: () => Promise<void>;
  openEvidenceFile: () => Promise<void>;
  saveFile: () => void;
  select: (id: string | null) => void;
  setSearch: (search: string) => void;
  toggleGraphExtras: () => void;

  saveField: (path: string, value: string) => Promise<void>;
  saveNode: (nodeId: string, patch: Partial<DialogueNode>) => Promise<void>;
  addNode: (nodeId: string, title?: string) => Promise<void>;
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
  doc: null,
  graph: null,
  source: "",
  selectedId: null,
  search: "",
  graphExtrasVisible: true,
  loading: false,
  error: null,
  evidenceCatalog: [],
  evidenceFileName: null,

  async openFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
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
            const raw = reader.result as string;
            const doc = CharacterDocument.parse(raw);
            doc.setEvidenceCatalog(get().evidenceCatalog);
            const graph = doc.toGraph();
            set({
              fileName: file.name,
              doc,
              graph,
              source: doc.serialize(),
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

  async openEvidenceFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve();
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const raw = reader.result as string;
            const catalog = CharacterDocument.parseEvidenceCatalog(raw);
            const { doc } = get();
            if (doc) {
              doc.setEvidenceCatalog(catalog);
              set({
                evidenceCatalog: catalog,
                evidenceFileName: file.name,
                graph: doc.toGraph(),
                source: doc.serialize(),
                error: null,
              });
            } else {
              set({
                evidenceCatalog: catalog,
                evidenceFileName: file.name,
                error: null,
              });
            }
          } catch (err) {
            set({ error: errorMessage(err) });
          }
          resolve();
        };
        reader.onerror = () => {
          set({ error: "Failed to read evidence file" });
          resolve();
        };
        reader.readAsText(file, "utf-8");
      };
      input.click();
    });
  },

  saveFile() {
    const { doc, fileName } = get();
    if (!doc || !fileName) return;
    const content = doc.serialize();
    const blob = new Blob([content], { type: "application/json" });
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

  async saveField(path, value) {
    mutate(get, set, (doc) => doc.patchField(path, value));
  },

  async saveNode(nodeId, patch) {
    mutate(get, set, (doc) =>
      doc.patchNode(nodeId, nodePartialToPatch(patch)),
    );
  },

  async addNode(nodeId, title) {
    mutate(get, set, (doc) => doc.createNode(nodeId, title), { selectedId: nodeId });
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
      mutate(get, set, (doc) => doc.renameEvidenceId(evidenceId, patch.newEvidenceId!));
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
  fn: (doc: CharacterDocument) => void,
  extra: Partial<GraphState> = {},
): void {
  const { doc } = get();
  if (!doc) return;
  try {
    fn(doc);
    const graph = doc.toGraph();
    const source = doc.serialize();
    set({ graph, source, error: null, ...extra });
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
    delivery_style: patch.delivery_style,
    progress_hints: patch.progress_hints,
    progress_hint_importance: patch.progress_hint_importance,
  };
}
