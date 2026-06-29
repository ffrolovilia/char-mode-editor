import type cytoscape from "cytoscape";

export type DialogueNode = {
  id: string;
  title: string;
  open_text: string;
  required_nodes: string[];
  required_nodes_mode: string;
  required_evidence_mode: string;
  required_evidence: string[];
  opened_evidence: string[];
  game_updates: Record<string, string>[];
  delivery_style: string;
  reveal_chunk_ids: string[];
  reveals: NodeRevealChunk[];
  progress_hint: string;
  progress_hint_importance: "low" | "med" | "max";
  progress_hints: NodeProgressHint[];
  paths: Record<string, string>;
};

export type KnowledgeChunk = {
  id: string;
  type: string;
  active_until: string;
  text: string;
  attrs: Record<string, string>;
  paths: Record<string, string>;
};

export type NodeRevealChunk = {
  id: string;
  type: string;
  active_until: string;
  text: string;
  exists: boolean;
  attrs: Record<string, string>;
  paths: Record<string, string>;
};

export type NodeProgressHint = {
  text: string;
  starts_after_turns: number;
  paths: Record<string, string>;
};

export type DialogueEdge = {
  source: string;
  target: string;
  condition: string;
  attrs: Record<string, string>;
};

export type EvidenceNode = {
  id: string;
  name: string;
  status: string;
  power: number;
  targets: string[];
  meaning: string;
  attrs: Record<string, string>;
  paths: Record<string, string>;
};

export type EvidenceCatalogItem = {
  id: string;
  title: string;
  description: string;
  status: string;
  available_from_start: boolean;
};

export type ValidationIssue = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  ref?: string | null;
};

export type FieldSection = {
  id: string;
  title: string;
  path: string;
  groups: FieldGroup[];
};

export type FieldGroup = {
  id: string;
  title: string;
  subtitle: string;
  fields: FieldEntry[];
};

export type FieldEntry = {
  path: string;
  label: string;
  value: string;
  tag: string;
  attrs: Record<string, string>;
};

export type CharacterGraph = {
  character_id: string;
  character_name: string;
  source_path: string;
  token_estimate: number;
  sections: FieldSection[];
  knowledge_chunks: KnowledgeChunk[];
  public_chunk_ids: string[];
  nodes: DialogueNode[];
  edges: DialogueEdge[];
  evidence: EvidenceNode[];
  evidence_catalog: EvidenceCatalogItem[];
  updates: Record<string, string>[];
  validation: ValidationIssue[];
  cytoscape: cytoscape.ElementDefinition[];
};
