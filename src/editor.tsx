import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import type {
  DialogueEdge,
  DialogueNode,
  EvidenceCatalogItem,
  EvidenceNode,
  FieldEntry,
  FieldGroup,
  FieldSection,
  KnowledgeChunk,
  NodeProgressHint,
  NodeRevealChunk,
  ValidationIssue,
} from "./types";
import { useGraphStore } from "./store";

// ─── Hooks ────────────────────────────────────────────────────────────────────

type SaveStatus = "clean" | "saving" | "saved" | "error";

function useSaveableDraft({
  canSave = () => true,
  normalize = (v: string) => v,
  onSave,
  resetKey,
  value,
}: {
  canSave?: (v: string) => boolean;
  normalize?: (v: string) => string;
  onSave: (v: string) => Promise<void>;
  resetKey: string;
  value: string | null | undefined;
}) {
  const safeValue = value ?? "";
  const [draft, setDraft] = useState(safeValue);
  const [status, setStatus] = useState<SaveStatus>("clean");

  useEffect(() => {
    setDraft(safeValue);
    setStatus("clean");
  }, [resetKey]);

  const normalizedDraft = normalize(draft);
  const dirty = normalizedDraft !== safeValue;

  const save = async () => {
    if (status === "saving") return;
    if (!canSave(normalizedDraft)) return;
    if (!dirty) {
      if (draft !== safeValue) setDraft(safeValue);
      return;
    }
    setStatus("saving");
    try {
      await onSave(normalizedDraft);
      setStatus("saved");
      window.setTimeout(() => setStatus("clean"), 900);
    } catch {
      setStatus("error");
    }
  };

  return { dirty, draft, save, setDraft, setStatus, status };
}

const STORAGE_PREFIX = "validation-accepted-issues:v1:";
const FP_SEP = "\x1f";

function issueFingerprint(issue: ValidationIssue): string {
  return [issue.severity, issue.code, issue.ref ?? "", issue.message].join(FP_SEP);
}

function useAcceptedValidationIssues(fileName: string, issues: ValidationIssue[]) {
  const [acceptedKeys, setAcceptedKeys] = useState<Set<string>>(() =>
    loadAcceptedKeys(fileName),
  );
  useEffect(() => {
    setAcceptedKeys(loadAcceptedKeys(fileName));
  }, [fileName]);

  const activeIssues = useMemo(
    () => issues.filter((i) => !acceptedKeys.has(issueFingerprint(i))),
    [acceptedKeys, issues],
  );
  const acceptedIssues = useMemo(
    () => issues.filter((i) => acceptedKeys.has(issueFingerprint(i))),
    [acceptedKeys, issues],
  );
  const acceptIssue = (issue: ValidationIssue) => {
    const next = new Set(acceptedKeys);
    next.add(issueFingerprint(issue));
    saveAcceptedKeys(fileName, next);
    setAcceptedKeys(next);
  };
  const restoreIssue = (issue: ValidationIssue) => {
    const next = new Set(acceptedKeys);
    next.delete(issueFingerprint(issue));
    saveAcceptedKeys(fileName, next);
    setAcceptedKeys(next);
  };
  return { acceptedIssues, acceptIssue, activeIssues, restoreIssue };
}

function loadAcceptedKeys(fileName: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(
      `${STORAGE_PREFIX}${fileName || "default"}`,
    );
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function saveAcceptedKeys(fileName: string, keys: Set<string>): void {
  try {
    const storageKey = `${STORAGE_PREFIX}${fileName || "default"}`;
    if (!keys.size) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, JSON.stringify([...keys]));
  } catch {}
}

function useConfirmedBusyAction(): [boolean, (msg: string, action: () => Promise<void>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const run = async (msg: string, action: () => Promise<void>) => {
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return [busy, run];
}

function useAutosizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  trigger: unknown,
  observeResize = false,
) {
  useLayoutEffect(() => {
    resize(ref.current);
  }, [ref, trigger]);

  useEffect(() => {
    if (!observeResize) return;
    const el = ref.current;
    if (!el) return;
    const container = el.parentElement;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => resize(el));
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    if (container) observer.observe(container);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [observeResize, ref]);
}

function resize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// ─── Small components ─────────────────────────────────────────────────────────

export type ReferenceOption = {
  description?: string;
  label: string;
  value: string;
};

function ReferenceOptionList({
  busy = false,
  emptyText = "No available options.",
  maxHeightClass = "max-h-52",
  onToggle,
  options,
  selectedValues,
}: {
  busy?: boolean;
  emptyText?: string;
  maxHeightClass?: string;
  onToggle: (value: string, selected: boolean) => void;
  options: ReferenceOption[];
  selectedValues: string[];
}) {
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);
  return (
    <div
      className={`grid ${maxHeightClass} gap-1 overflow-auto border-t border-white/10 p-2`}
    >
      {options.length ? (
        options.map((option) => {
          const selected = selectedSet.has(option.value);
          return (
            <label
              className={[
                "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition",
                selected
                  ? "border-cyan-300/35 bg-cyan-300/10 text-zinc-100"
                  : "border-white/5 bg-white/[0.02] text-zinc-300 hover:border-white/15 hover:bg-white/[0.04]",
                busy ? "cursor-wait opacity-70" : "",
              ].join(" ")}
              key={option.value}
            >
              <input
                checked={selected}
                className="mt-0.5 h-4 w-4 accent-cyan-300"
                disabled={busy}
                onChange={(e) => onToggle(option.value, e.target.checked)}
                type="checkbox"
              />
              <span className="grid min-w-0 gap-1">
                <span className="truncate font-mono text-xs font-semibold">
                  {option.label}
                </span>
                {option.description && (
                  <span className="text-xs leading-5 text-zinc-500">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          );
        })
      ) : (
        <span className="px-2 py-3 text-xs text-zinc-500">{emptyText}</span>
      )}
    </div>
  );
}

function EditableSelectChip({
  allowEmpty = false,
  ariaLabel,
  className,
  disabled = false,
  emptyLabel = "missing",
  onSave,
  options,
  prefix = "",
  value,
}: {
  allowEmpty?: boolean;
  ariaLabel: string;
  className: string;
  disabled?: boolean;
  emptyLabel?: string;
  onSave: (value: string) => Promise<void>;
  options: string[];
  prefix?: string;
  value: string | null | undefined;
}) {
  const safeValue = value ?? "";
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const selectOptions =
    options.includes(safeValue) || !safeValue ? options : [safeValue, ...options];

  const commit = async (next: string) => {
    if (next === safeValue) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <select
        autoFocus
        aria-label={ariaLabel}
        className="h-7 rounded-md border border-cyan-300/35 bg-black/45 px-2 font-mono text-[11px] uppercase text-zinc-100 outline-none transition focus:border-cyan-200/70"
        disabled={saving}
        value={safeValue}
        onBlur={() => setEditing(false)}
        onChange={(e) => void commit(e.target.value)}
      >
        {(allowEmpty || !safeValue) && <option value="">{emptyLabel}</option>}
        {selectOptions.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  return (
    <button
      aria-label={ariaLabel}
      className={`rounded border px-2 py-0.5 font-mono text-[11px] uppercase transition disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
      disabled={disabled}
      onClick={() => setEditing(true)}
      type="button"
    >
      {safeValue ? `${prefix}${safeValue}` : emptyLabel}
    </button>
  );
}

// ─── ValidationIssueList ──────────────────────────────────────────────────────

type IssueGuide = { title: string; summary: string; check: string };

const ISSUE_GUIDES: Record<string, IssueGuide> = {
  node_never_openable: {
    title: "Node cannot open",
    summary:
      "No simulated route can satisfy this node's current node/evidence requirements.",
    check:
      "Check the required nodes and evidence first; this is often caused by a required evidence issue above.",
  },
  stage_active_until_not_reachable: {
    title: "Stage chunk cannot expire",
    summary:
      "A STAGE chunk points to an active_until node that is not reachable after the node that reveals it.",
    check:
      "Change active_until to a reachable later node, or connect the graph so that active_until can open after this stage starts.",
  },
  node_requires_evidence_it_opens: {
    title: "Node requires evidence it opens itself",
    summary: "The node cannot use its own reward evidence as a prerequisite.",
    check:
      "Move the evidence unlock to an earlier node, or remove the evidence from this node's requirements.",
  },
};

const DEFAULT_GUIDE: IssueGuide = {
  title: "Validation issue",
  summary: "The graph validator found a rule violation in this character.",
  check:
    "Open the raw validator message and inspect the referenced node, evidence, or chunk.",
};

function ValidationIssueList({
  acceptedIssues = [],
  emptyText = "No issues detected.",
  issues,
  onAcceptIssue,
  onRestoreIssue,
}: {
  acceptedIssues?: ValidationIssue[];
  emptyText?: string;
  issues: ValidationIssue[];
  onAcceptIssue?: (issue: ValidationIssue) => void;
  onRestoreIssue?: (issue: ValidationIssue) => void;
}) {
  const groups = groupByCode(issues);
  return (
    <div className="grid gap-3">
      {!issues.length && <p className="text-sm text-emerald-200">{emptyText}</p>}
      {groups.map(({ code, groupIssues, guide }) => (
        <article
          className={
            groupIssues.some((i) => i.severity === "error")
              ? "rounded-lg border border-red-400/25 bg-red-500/10 p-3 text-red-50"
              : "rounded-lg border border-amber-300/25 bg-amber-300/10 p-3 text-amber-50"
          }
          key={code}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-50">{guide.title}</h3>
              <p className="mt-1 text-xs leading-5 text-zinc-300">{guide.summary}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="rounded-md border border-white/10 bg-black/25 px-2 py-0.5 font-mono text-[11px] uppercase text-zinc-400">
                {code}
              </span>
              <span className="rounded-md border border-white/10 bg-black/25 px-2 py-0.5 text-xs text-zinc-300">
                {groupIssues.length}
              </span>
            </div>
          </div>
          <div className="mt-3 grid gap-2">
            {groupIssues.map((issue, idx) => (
              <IssueCard
                issue={issue}
                key={`${issue.code}-${issue.ref ?? "graph"}-${idx}`}
                onAcceptIssue={onAcceptIssue}
              />
            ))}
          </div>
          <p className="mt-3 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs leading-5 text-zinc-300">
            <span className="font-semibold text-zinc-100">Check: </span>
            {guide.check}
          </p>
        </article>
      ))}
      {acceptedIssues.length > 0 && (
        <details className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 p-3 text-emerald-50">
          <summary className="cursor-pointer select-none text-sm font-semibold">
            Accepted hidden issues ({acceptedIssues.length})
          </summary>
          <div className="mt-3 grid gap-2">
            {acceptedIssues.map((issue, idx) => (
              <IssueCard
                accepted
                issue={issue}
                key={`${issue.code}-${issue.ref ?? "graph"}-${idx}`}
                onRestoreIssue={onRestoreIssue}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function IssueCard({
  accepted = false,
  issue,
  onAcceptIssue,
  onRestoreIssue,
}: {
  accepted?: boolean;
  issue: ValidationIssue;
  onAcceptIssue?: (issue: ValidationIssue) => void;
  onRestoreIssue?: (issue: ValidationIssue) => void;
}) {
  const facts = issueFacts(issue);
  const [primary, ...secondary] = facts;
  return (
    <div className="rounded-md border border-white/10 bg-black/25 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={
              issue.severity === "error"
                ? "rounded border border-red-300/25 bg-red-300/10 px-2 py-0.5 text-[11px] font-semibold uppercase text-red-100"
                : "rounded border border-amber-300/25 bg-amber-300/10 px-2 py-0.5 text-[11px] font-semibold uppercase text-amber-100"
            }
          >
            {issue.severity}
          </span>
          <span className="rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] uppercase text-zinc-300">
            {issue.code}
          </span>
          {accepted && (
            <span className="rounded border border-emerald-300/25 bg-emerald-300/10 px-2 py-0.5 text-[11px] font-semibold uppercase text-emerald-100">
              accepted
            </span>
          )}
          {primary && (
            <span className="min-w-0 rounded border border-cyan-300/15 bg-cyan-300/10 px-2 py-0.5 text-[11px] text-cyan-100">
              <span className="text-cyan-100/55">{primary.label}</span> {primary.value}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onAcceptIssue && (
            <button
              className="ide-button ide-button-primary px-2.5 py-1 text-xs"
              onClick={() => onAcceptIssue(issue)}
              type="button"
            >
              Mark normal
            </button>
          )}
          {onRestoreIssue && (
            <button
              className="ide-button px-2.5 py-1 text-xs"
              onClick={() => onRestoreIssue(issue)}
              type="button"
            >
              Restore
            </button>
          )}
        </div>
      </div>
      {secondary.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {secondary.map((f) => (
            <span
              className="rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-zinc-300"
              key={`${f.label}:${f.value}`}
            >
              <span className="text-zinc-500">{f.label}</span> {f.value}
            </span>
          ))}
        </div>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer select-none text-xs font-medium text-zinc-400 transition hover:text-zinc-100">
          Raw validator message
        </summary>
        <p className="mt-1 text-xs leading-5 text-zinc-300">{issue.message}</p>
      </details>
    </div>
  );
}

function groupByCode(
  issues: ValidationIssue[],
): { code: string; groupIssues: ValidationIssue[]; guide: IssueGuide }[] {
  const groups = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    groups.set(issue.code, [...(groups.get(issue.code) ?? []), issue]);
  }
  return [...groups.entries()].map(([code, groupIssues]) => ({
    code,
    groupIssues,
    guide: ISSUE_GUIDES[code] ?? DEFAULT_GUIDE,
  }));
}

function issueFacts(issue: ValidationIssue): { label: string; value: string }[] {
  if (issue.code === "stage_active_until_not_reachable") {
    return [
      { label: "chunk", value: issue.ref ?? "unknown" },
      { label: "revealed by", value: quotedValue(issue.message, "revealed by") },
      { label: "active_until", value: quotedValue(issue.message, "active_until") },
    ];
  }
  if (
    issue.code === "node_never_openable" ||
    issue.code === "node_requires_evidence_it_opens"
  )
    return [{ label: "node", value: issue.ref ?? "unknown" }];
  return issue.ref
    ? [{ label: "ref", value: issue.ref }]
    : [{ label: "scope", value: "graph" }];
}

function quotedValue(msg: string, label: string): string {
  const idx = msg.indexOf(label);
  if (idx === -1) return "unknown";
  const match = msg.slice(idx + label.length).match(/'([^']+)'/);
  return match?.[1] ?? "unknown";
}

// ─── CharacterContextPanel ────────────────────────────────────────────────────

export function CharacterContextPanel() {
  const graph = useGraphStore((s) => s.graph);
  const search = useGraphStore((s) => s.search);
  const fileName = useGraphStore((s) => s.fileName) ?? "";
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const validationIssues = graph?.validation ?? [];
  const { acceptedIssues, acceptIssue, activeIssues, restoreIssue } =
    useAcceptedValidationIssues(fileName, validationIssues);

  if (!graph)
    return (
      <aside className="ide-panel border-r p-5 text-sm text-zinc-400">
        Loading character.
      </aside>
    );

  const sections = (graph.sections ?? []).filter((s) => s.id !== "character");
  const issueCount = activeIssues.length;
  const isValid = issueCount === 0;
  const toggle = (id: string) =>
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  return (
    <aside className="ide-panel border-r">
      <div className="ide-panel-header">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200">
              Character JSON
            </p>
            <h1
              className={
                isValid
                  ? "mt-1 text-2xl font-semibold text-zinc-50"
                  : "mt-1 text-2xl font-semibold text-red-100"
              }
            >
              {graph.character_name || graph.character_id}
            </h1>
          </div>
          <span
            className={
              isValid
                ? "ide-pill ide-status-ok font-mono"
                : "ide-pill ide-status-error font-mono"
            }
            title={
              isValid
                ? "Character validation passed"
                : `${issueCount} validation issue(s)`
            }
          >
            {isValid ? "valid" : `${issueCount} issues`}
          </span>
        </div>
        {(issueCount > 0 || acceptedIssues.length > 0) && (
          <ValidationSummary
            acceptedIssues={acceptedIssues}
            issues={activeIssues}
            onAcceptIssue={acceptIssue}
            onRestoreIssue={restoreIssue}
          />
        )}
      </div>

      <div className="grid gap-5 p-5">
        {sections.map((section) =>
          section.id === "evidence_index" ? (
            <EvidenceIndexSection
              catalog={graph.evidence_catalog ?? []}
              collapsed={collapsed[section.id] ?? false}
              evidence={graph.evidence ?? []}
              key={section.id}
              onToggle={() => toggle(section.id)}
              search={search}
              section={section}
            />
          ) : (
            <SectionBlock
              collapsed={collapsed[section.id] ?? false}
              key={section.id}
              onToggle={() => toggle(section.id)}
              search={search}
              section={section}
            />
          ),
        )}
      </div>
    </aside>
  );
}

function ValidationSummary({
  acceptedIssues,
  issues,
  onAcceptIssue,
  onRestoreIssue,
}: {
  acceptedIssues: ValidationIssue[];
  issues: ValidationIssue[];
  onAcceptIssue: (i: ValidationIssue) => void;
  onRestoreIssue: (i: ValidationIssue) => void;
}) {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const cls = issues.length
    ? "mt-3 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-sm text-red-100"
    : "mt-3 rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-sm text-emerald-100";
  return (
    <details className={cls}>
      <summary className="cursor-pointer select-none font-medium">
        Validation: {errors} errors, {warnings} warnings
        {acceptedIssues.length > 0 ? `, ${acceptedIssues.length} accepted` : ""}
      </summary>
      <div className="mt-3">
        <ValidationIssueList
          acceptedIssues={acceptedIssues}
          emptyText="No active issues detected."
          issues={issues}
          onAcceptIssue={onAcceptIssue}
          onRestoreIssue={onRestoreIssue}
        />
      </div>
    </details>
  );
}

function EvidenceIndexSection({
  catalog,
  collapsed,
  evidence,
  onToggle,
  search,
  section,
}: {
  catalog: EvidenceCatalogItem[];
  collapsed: boolean;
  evidence: EvidenceNode[];
  onToggle: () => void;
  search: string;
  section: FieldSection;
}) {
  const addEvidenceIndexItem = useGraphStore((s) => s.addEvidenceIndexItem);
  const deleteEvidenceIndexItem = useGraphStore((s) => s.deleteEvidenceIndexItem);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [busyId, setBusyId] = useState("");

  const catalogById = useMemo(
    () => new Map(catalog.map((item) => [item.id, item])),
    [catalog],
  );
  const catalogOptions = useMemo(
    () =>
      catalog.map((item) => ({
        description: [item.title, catalogStatus(item), item.description]
          .filter(Boolean)
          .join(" · "),
        label: item.id,
        value: item.id,
      })),
    [catalog],
  );
  const resolved = useMemo(
    () => evidence.map((e) => resolveEvidence(e, catalogById)),
    [catalogById, evidence],
  );
  const selectedIds = useMemo(() => resolved.map((e) => e.id), [resolved]);
  const visible = useMemo(() => {
    if (!search.trim()) return resolved;
    const q = search.trim().toLowerCase();
    return resolved.filter((e) =>
      [e.id, e.name, e.status, e.meaning].join(" ").toLowerCase().includes(q),
    );
  }, [resolved, search]);

  if (!visible.length && search.trim()) return null;

  const toggleEvidence = async (id: string, shouldSelect: boolean) => {
    if (busyId) return;
    if (!shouldSelect) {
      if (!window.confirm(`Remove "${id}" from evidence_index?`)) return;
    }
    setBusyId(id);
    try {
      if (shouldSelect) await addEvidenceIndexItem(id);
      else await deleteEvidenceIndexItem(id);
    } finally {
      setBusyId("");
    }
  };

  return (
    <section>
      <CollapsibleSectionHeader
        collapsed={collapsed}
        count={evidence.length}
        title={section.title}
        onToggle={onToggle}
      />
      {!collapsed && (
        <div className="grid gap-3">
          <div className="overflow-hidden rounded-md border border-white/10 bg-black/20">
            <button
              aria-expanded={selectorOpen}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
              onClick={() => setSelectorOpen((c) => !c)}
              type="button"
            >
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Evidence catalog
              </span>
              <span className="ide-button px-2.5 py-1 text-xs">
                {selectorOpen ? "Hide" : "Select"}
              </span>
            </button>
            {selectorOpen && (
              <ReferenceOptionList
                busy={Boolean(busyId)}
                maxHeightClass="max-h-64"
                onToggle={(v, sel) => void toggleEvidence(v, sel)}
                options={catalogOptions}
                selectedValues={selectedIds}
              />
            )}
          </div>
          {visible.map((item) => (
            <EvidenceIndexCard evidence={item} key={item.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function EvidenceIndexCard({ evidence }: { evidence: EvidenceNode }) {
  const updateEvidenceIndexItem = useGraphStore((s) => s.updateEvidenceIndexItem);
  const deleteEvidenceIndexItem = useGraphStore((s) => s.deleteEvidenceIndexItem);
  const [deleting, runDelete] = useConfirmedBusyAction();

  const remove = () =>
    runDelete(
      `Delete evidence "${evidence.id}" from evidence_index?`,
      () => deleteEvidenceIndexItem(evidence.id),
    );

  return (
    <article className="ide-card grid gap-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="grid min-w-0 flex-1 gap-2">
          <EvidenceInlineText
            className="font-mono text-base font-semibold text-cyan-100"
            placeholder="evidence_id"
            value={evidence.id}
            onSave={(v) => updateEvidenceIndexItem(evidence.id, { newEvidenceId: v })}
          />
          <p className="truncate text-sm font-medium text-zinc-100">
            {evidence.name || "Missing global evidence"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`rounded-md border px-2.5 py-1 font-mono text-xs font-semibold ${
              evidence.status === "initial"
                ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
                : "border-white/10 bg-white/[0.04] text-zinc-300"
            }`}
          >
            {evidence.status || "missing"}
          </span>
          <button
            className="ide-button ide-button-danger px-2.5 py-1 text-xs disabled:opacity-50"
            disabled={deleting}
            onClick={remove}
            type="button"
          >
            {deleting ? "Deleting" : "Delete"}
          </button>
        </div>
      </div>
      <p className="text-sm leading-6 text-zinc-200">
        {evidence.meaning || "No global description."}
      </p>
    </article>
  );
}

function EvidenceInlineText({
  className,
  onSave,
  placeholder,
  value,
}: {
  className: string;
  onSave: (v: string) => Promise<void>;
  placeholder: string;
  value: string;
}) {
  const { draft, save, setDraft, status } = useSaveableDraft({
    canSave: (v) => Boolean(v.trim()),
    normalize: (v) => v.trim(),
    onSave,
    resetKey: `${placeholder}:${value}`,
    value,
  });
  const saving = status === "saving";
  const handleBlur = async () => {
    if (!draft.trim()) {
      setDraft(value);
      return;
    }
    await save();
  };
  return (
    <input
      className={`w-full rounded-none border-0 border-b border-white/10 bg-transparent px-0 pb-1 pt-0 outline-none transition placeholder:text-zinc-600 focus:border-cyan-300/60 disabled:opacity-60 ${className}`}
      disabled={saving}
      placeholder={placeholder}
      value={draft}
      onBlur={handleBlur}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

function SectionBlock({
  collapsed,
  onToggle,
  search,
  section,
}: {
  collapsed: boolean;
  onToggle: () => void;
  search: string;
  section: FieldSection;
}) {
  const visibleGroups = useMemo(() => {
    if (!search.trim()) return section.groups;
    const q = search.trim().toLowerCase();
    return section.groups.filter((group) => {
      const hay = [
        group.title,
        group.subtitle,
        ...group.fields.flatMap((f) => [f.label, f.value, ...Object.values(f.attrs)]),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [section.groups, search]);

  if (!visibleGroups.length) return null;

  return (
    <section>
      <CollapsibleSectionHeader
        collapsed={collapsed}
        count={visibleGroups.length}
        title={section.title}
        onToggle={onToggle}
      />
      {!collapsed && (
        <div className="grid gap-3">
          {visibleGroups.map((group) => (
            <GroupCard group={group} key={group.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function CollapsibleSectionHeader({
  collapsed,
  count,
  onToggle,
  title,
}: {
  collapsed: boolean;
  count: number;
  onToggle: () => void;
  title: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <button
        className="group flex min-w-0 items-center gap-2 text-left"
        onClick={onToggle}
        type="button"
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md border border-white/10 bg-white/[0.035] text-xs text-zinc-500 transition group-hover:border-cyan-400/45 group-hover:text-cyan-100">
          {collapsed ? "+" : "-"}
        </span>
        <h2 className="truncate text-sm font-semibold uppercase tracking-wide text-zinc-400 transition group-hover:text-zinc-100">
          {title}
        </h2>
      </button>
      <button
        className="rounded-md border border-white/10 bg-white/[0.035] px-2 py-0.5 text-xs text-zinc-500 transition hover:border-cyan-400/40 hover:text-cyan-100"
        onClick={onToggle}
        type="button"
      >
        {count}
      </button>
    </div>
  );
}

function GroupCard({ group }: { group: FieldGroup }) {
  return (
    <article className="ide-card">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-zinc-100">{group.title}</h3>
          {group.subtitle && (
            <p className="mt-1 text-xs leading-5 text-zinc-500">{group.subtitle}</p>
          )}
        </div>
        <span className="ide-pill">{group.fields.length}</span>
      </div>
      <div className="grid gap-3">
        {group.fields.map((field) => (
          <EditableField field={field} key={field.path} />
        ))}
      </div>
    </article>
  );
}

function EditableField({ field }: { field: FieldEntry }) {
  const saveField = useGraphStore((s) => s.saveField);
  const { dirty, draft, save, setDraft, status } = useSaveableDraft({
    onSave: (v) => saveField(field.path, v),
    resetKey: `${field.path}:${field.value}`,
    value: field.value,
  });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useAutosizeTextarea(textareaRef, draft, true);

  return (
    <label className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          {field.label}
        </span>
        <button
          className="ide-button ide-button-primary px-2.5 py-1 text-xs disabled:bg-white/[0.04]"
          disabled={!dirty || status === "saving"}
          onClick={save}
          type="button"
        >
          {status === "saving"
            ? "Saving"
            : status === "saved"
              ? "Saved"
              : status === "error"
                ? "Retry"
                : "Save"}
        </button>
      </div>
      <textarea
        ref={textareaRef}
        className="input min-h-10 resize-none overflow-hidden leading-6"
        value={draft}
        onBlur={save}
        onChange={(e) => setDraft(e.target.value)}
      />
    </label>
  );
}

function resolveEvidence(
  evidence: EvidenceNode,
  catalogById: Map<string, EvidenceCatalogItem>,
): EvidenceNode {
  const item = catalogById.get(evidence.id);
  if (!item) return evidence;
  return {
    ...evidence,
    name: item.title || evidence.name,
    status: catalogStatus(item) || evidence.status,
    meaning: item.description || evidence.meaning,
  };
}

function catalogStatus(item: EvidenceCatalogItem): string {
  return item.status || (item.available_from_start ? "initial" : "locked");
}

// ─── InspectorPanel ───────────────────────────────────────────────────────────

const REQUIRE_MODES = ["none", "all", "any"];
const CHUNK_TYPES = ["fact", "stage"];
const PROGRESS_HINT_IMPORTANCES = ["low", "med", "max"];
const DEFAULT_HINT_START_TURNS = 2;

export function InspectorPanel() {
  const {
    graph,
    selectedId,
    saveNode,
    deleteNode,
    addEdge,
    deleteEdge,
    addEvidenceRequirement,
    deleteEvidenceRequirement,
    addGameUpdateItem,
    deleteGameUpdateItem,
    addNodeReveal,
    deleteNodeReveal,
    addKnowledgeChunk,
    updateKnowledgeChunk,
    deleteKnowledgeChunk,
  } = useGraphStore();
  const fileName = useGraphStore((s) => s.fileName) ?? "";

  const selectedNode = useMemo(
    () => graph?.nodes.find((n) => n.id === selectedId) ?? null,
    [graph, selectedId],
  );
  const nodeOptions = useMemo<ReferenceOption[]>(
    () =>
      graph?.nodes.map((n) => ({
        description: n.title,
        label: n.id,
        value: n.id,
      })) ?? [],
    [graph],
  );
  const evidenceOptions = useMemo<ReferenceOption[]>(
    () =>
      graph?.evidence.map((e) => ({
        description: e.meaning,
        label: e.id,
        value: e.id,
      })) ?? [],
    [graph],
  );

  const [draft, setDraft] = useState<DialogueNode | null>(null);
  const [newReveal, setNewReveal] = useState("");
  const [newChunkType, setNewChunkType] = useState("fact");
  const [newChunkActiveUntil, setNewChunkActiveUntil] = useState("");
  const [newChunkText, setNewChunkText] = useState("");
  const [createChunkOpen, setCreateChunkOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    setDraft(selectedNode ? structuredClone(selectedNode) : null);
    setNewReveal("");
    setNewChunkType("fact");
    setNewChunkActiveUntil("");
    setNewChunkText("");
    setCreateChunkOpen(false);
    setDirty(false);
    setSaveError("");
  }, [selectedNode]);

  useEffect(() => {
    if (!dirty || !draft) return;
    const t = window.setTimeout(() => void save(), 700);
    return () => window.clearTimeout(t);
  }, [dirty, draft]);

  const { activeIssues } = useAcceptedValidationIssues(
    fileName,
    graph?.validation ?? [],
  );

  if (!graph)
    return (
      <aside className="ide-panel p-5 text-sm text-zinc-400">Graph is loading.</aside>
    );

  if (!draft || !selectedNode) {
    return (
      <aside className="ide-panel p-5">
        <div className="ide-section">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-cyan-200">
            Node Inspector
          </h2>
          <p className="mt-3 text-sm leading-6 text-zinc-400">
            Select a dialogue node on the graph.
          </p>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
          {[
            { label: "Nodes", value: graph.nodes.length },
            { label: "Edges", value: graph.edges.length },
            { label: "Evidence", value: graph.evidence.length },
            { label: "Issues", value: activeIssues.length },
          ].map((m) => (
            <div className="ide-subcard" key={m.label}>
              <dt className="text-xs text-zinc-500">{m.label}</dt>
              <dd className="mt-1 text-lg font-semibold text-zinc-100">{m.value}</dd>
            </div>
          ))}
        </dl>
      </aside>
    );
  }

  const update = <K extends keyof DialogueNode>(key: K, value: DialogueNode[K]) => {
    setDraft({ ...draft, [key]: value });
    setDirty(true);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError("");
    try {
      await saveNode(draft.id, {
        title: draft.title,
        open_text: draft.open_text,
        required_nodes_mode: draft.required_nodes_mode,
        required_evidence_mode: draft.required_evidence_mode,
        delivery_style: draft.delivery_style,
        progress_hint_importance: draft.progress_hint_importance,
        progress_hints: draft.progress_hints,
      });
      setDirty(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const removeSelectedNode = async () => {
    if (!draft) return;
    if (
      !window.confirm(
        `Delete node ${draft.id}? This also removes edges and node references that point to it.`,
      )
    )
      return;
    setSaving(true);
    setSaveError("");
    try {
      await deleteNode(draft.id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const edgeForRequired = (source: string): DialogueEdge =>
    graph.edges.find((e) => e.source === source && e.target === draft.id) ?? {
      source,
      target: draft.id,
      condition: draft.required_nodes_mode ? `requires:${draft.required_nodes_mode}` : "",
      attrs: {},
    };

  const factReveals = draft.reveals.filter((r) => r.exists && r.type === "fact");
  const stageReveals = draft.reveals.filter((r) => r.exists && r.type === "stage");
  const otherReveals = draft.reveals.filter(
    (r) => !r.exists || !["fact", "stage"].includes(r.type),
  );
  const generatedChunkId = nextChunkId(
    graph.character_name,
    draft.id,
    newChunkType,
    graph.knowledge_chunks ?? [],
  );

  const renderReveal = (reveal: NodeRevealChunk) => (
    <RevealChunkCard
      activeUntilOptions={graph.nodes.map((n) => n.id)}
      chunk={reveal}
      key={`${draft.id}-${reveal.id}-${reveal.paths.reveal ?? reveal.id}`}
      onDeleteChunk={() => deleteKnowledgeChunk(reveal.id)}
      onDeleteReveal={() => deleteNodeReveal(draft.id, reveal.id)}
      onPatchChunk={(patch) => updateKnowledgeChunk(reveal.id, patch)}
    />
  );

  const updateHint = (index: number, patch: Partial<NodeProgressHint>) => {
    update(
      "progress_hints",
      draft.progress_hints.map((h, i) => (i === index ? { ...h, ...patch } : h)),
    );
  };
  const deleteHint = (index: number) => {
    update(
      "progress_hints",
      draft.progress_hints.filter((_, i) => i !== index),
    );
  };
  const addHint = () => {
    update("progress_hints", [
      ...draft.progress_hints,
      { starts_after_turns: DEFAULT_HINT_START_TURNS, text: "", paths: {} },
    ]);
  };

  return (
    <aside className="ide-panel text-zinc-100">
      <div className="ide-panel-header">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-mono text-2xl font-semibold tracking-normal text-cyan-100">
              {draft.id}
            </h2>
            <input
              aria-label="Node title"
              className="mt-2 w-full rounded-none border-0 border-b border-white/10 bg-transparent px-0 pb-2 pt-0 text-lg font-medium leading-7 text-zinc-50 outline-none transition placeholder:text-zinc-600 focus:border-cyan-300/60"
              placeholder="Untitled node"
              value={draft.title}
              onChange={(e) => update("title", e.target.value)}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              className="ide-button ide-button-danger py-1.5"
              disabled={saving}
              onClick={removeSelectedNode}
              type="button"
            >
              Delete node
            </button>
            <button
              className={
                saveError
                  ? "ide-button ide-button-danger py-1.5"
                  : "ide-button ide-button-primary py-1.5"
              }
              onClick={save}
              type="button"
            >
              {saving ? "Saving" : saveError ? "Error" : dirty ? "Pending" : "Saved"}
            </button>
          </div>
        </div>
        {saveError && (
          <p className="mt-3 rounded-md border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-100">
            {saveError}
          </p>
        )}
      </div>

      <div className="grid gap-4 p-5">
        <InspectorSection
          path={draft.paths.open}
          subtitle="Strict requirements plus soft open_logic for this node."
          title="Open"
        >
          <div className="ide-subcard grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="font-mono text-xs font-semibold text-zinc-400">
                requires.nodes
              </h4>
              <SelectInline
                options={REQUIRE_MODES}
                value={draft.required_nodes_mode}
                onChange={(v) => update("required_nodes_mode", v)}
              />
            </div>
            <ReferenceMultiSelect
              actionLabel="Choose nodes"
              emptyText="No required nodes."
              options={nodeOptions}
              selectedValues={draft.required_nodes}
              onAdd={(id) =>
                addEdge(id, draft.id, draft.required_nodes_mode || undefined)
              }
              onRemove={(id) => deleteEdge(edgeForRequired(id))}
            />
          </div>

          <div className="ide-subcard grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="font-mono text-xs font-semibold text-zinc-400">
                requires.evidence
              </h4>
              <SelectInline
                options={REQUIRE_MODES}
                value={draft.required_evidence_mode}
                onChange={(v) => update("required_evidence_mode", v)}
              />
            </div>
            <ReferenceMultiSelect
              actionLabel="Choose evidence"
              emptyText="No required evidence."
              options={evidenceOptions}
              selectedValues={draft.required_evidence}
              onAdd={(id) => addEvidenceRequirement(draft.id, id)}
              onRemove={(id) => deleteEvidenceRequirement(draft.id, id)}
            />
          </div>

          <EditableText
            multiline
            label="open_logic"
            value={draft.open_text}
            onChange={(v) => update("open_text", v)}
          />
        </InspectorSection>

        <InspectorSection
          path={draft.paths.reveals}
          subtitle="v5 disclosure: this node opens these knowledge chunks."
          title="Reveals / Chunks"
        >
          <datalist id="chunk-id-options">
            {(graph.knowledge_chunks ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.text}
              </option>
            ))}
          </datalist>
          <datalist id="node-id-options">
            {graph.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </datalist>

          {draft.reveals.length ? (
            <div className="grid gap-4">
              <RevealChunkGroup
                count={factReveals.length}
                subtitle="Stable knowledge that becomes true after this node opens."
                title="FACTS"
                tone="fact"
              >
                {factReveals.length ? (
                  factReveals.map(renderReveal)
                ) : (
                  <p className="ide-empty">No FACT chunks.</p>
                )}
              </RevealChunkGroup>
              {stageReveals.length > 0 && (
                <RevealChunkGroup
                  count={stageReveals.length}
                  subtitle="Temporary behavior until active_until opens."
                  title="STAGE"
                  tone="stage"
                >
                  {stageReveals.map(renderReveal)}
                </RevealChunkGroup>
              )}
              {otherReveals.length > 0 && (
                <RevealChunkGroup
                  count={otherReveals.length}
                  subtitle="Missing chunks or chunks with an invalid type."
                  title="Needs Attention"
                  tone="other"
                >
                  {otherReveals.map(renderReveal)}
                </RevealChunkGroup>
              )}
            </div>
          ) : (
            <p className="ide-empty">No reveal chunks.</p>
          )}

          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              className="input min-w-0"
              list="chunk-id-options"
              placeholder="existing_chunk_id"
              value={newReveal}
              onChange={(e) => setNewReveal(e.target.value)}
            />
            <button
              className="ide-button ide-button-primary disabled:opacity-50"
              disabled={!newReveal.trim()}
              onClick={() => {
                void addNodeReveal(draft.id, newReveal.trim());
                setNewReveal("");
              }}
              type="button"
            >
              Add reveal
            </button>
          </div>

          <div className="overflow-hidden rounded-md border border-white/10 bg-black/20">
            <button
              aria-expanded={createChunkOpen}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
              onClick={() => setCreateChunkOpen((c) => !c)}
              type="button"
            >
              <span className="font-mono text-xs font-semibold text-zinc-400">
                create chunk and reveal it
              </span>
              <span className="ide-button px-2.5 py-1 text-xs">
                {createChunkOpen ? "Hide" : "Create"}
              </span>
            </button>
            {createChunkOpen && (
              <div className="grid gap-3 border-t border-white/10 p-3">
                <div className="grid grid-cols-[minmax(0,1fr)_7rem_8rem] gap-2">
                  <input
                    className="input min-w-0 disabled:cursor-not-allowed disabled:text-zinc-400"
                    disabled
                    placeholder="chunk_id"
                    value={generatedChunkId}
                  />
                  <SelectInline
                    options={CHUNK_TYPES}
                    value={newChunkType}
                    onChange={setNewChunkType}
                  />
                  <input
                    className="input min-w-0"
                    list="node-id-options"
                    placeholder="active_until"
                    value={newChunkActiveUntil}
                    onChange={(e) => setNewChunkActiveUntil(e.target.value)}
                  />
                </div>
                <textarea
                  className="input min-h-24 resize-y leading-6"
                  placeholder="chunk text"
                  value={newChunkText}
                  onChange={(e) => setNewChunkText(e.target.value)}
                />
                <button
                  className="ide-button ide-button-primary disabled:opacity-50"
                  disabled={!generatedChunkId}
                  onClick={async () => {
                    await addKnowledgeChunk(
                      generatedChunkId,
                      newChunkType,
                      newChunkText,
                      newChunkActiveUntil.trim() || undefined,
                    );
                    await addNodeReveal(draft.id, generatedChunkId);
                    setNewChunkType("fact");
                    setNewChunkActiveUntil("");
                    setNewChunkText("");
                    setCreateChunkOpen(false);
                  }}
                  type="button"
                >
                  Create chunk
                </button>
              </div>
            )}
          </div>
        </InspectorSection>

        <InspectorSection
          path={draft.paths.delivery_style}
          subtitle="Presentation fields. Facts still belong in chunks."
          title="Delivery / Progress"
        >
          <EditableText
            multiline
            label="delivery_style"
            value={draft.delivery_style}
            onChange={(v) => update("delivery_style", v)}
          />
          <ProgressHintsEditor
            hints={draft.progress_hints}
            importance={draft.progress_hint_importance}
            onAdd={addHint}
            onDelete={deleteHint}
            onImportanceChange={(v) => update("progress_hint_importance", cleanImportance(v))}
            onPatch={updateHint}
          />
        </InspectorSection>

        <InspectorSection
          path={draft.paths.game_update}
          subtitle="Evidence unlocked when this node opens."
          title="Unlocked Evidence"
        >
          <div className="ide-subcard grid gap-3">
            <h4 className="font-mono text-xs font-semibold text-zinc-400">
              open_evidence
            </h4>
            <ReferenceMultiSelect
              actionLabel="Choose evidence"
              emptyText="No opened evidence."
              options={evidenceOptions}
              selectedValues={draft.opened_evidence}
              onAdd={(id) => addGameUpdateItem("open-evidence", draft.id, id)}
              onRemove={(id) => deleteGameUpdateItem("open-evidence", draft.id, id)}
            />
          </div>
        </InspectorSection>
      </div>
    </aside>
  );
}

// ─── Inspector sub-components ─────────────────────────────────────────────────

function InspectorSection({
  children,
  onDelete,
  path,
  subtitle,
  title,
}: {
  children: ReactNode;
  onDelete?: (path: string) => void;
  path?: string;
  subtitle?: string;
  title: string;
}) {
  return (
    <section className="ide-section">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
          {subtitle && (
            <p className="mt-1 text-xs leading-5 text-zinc-500">{subtitle}</p>
          )}
        </div>
        {path && onDelete && (
          <button
            className="ide-button ide-button-danger px-2 py-1 text-xs"
            onClick={() => onDelete(path)}
            type="button"
          >
            Delete block
          </button>
        )}
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function EditableText({
  code = false,
  label,
  multiline = false,
  onChange,
  onDelete,
  path,
  value,
}: {
  code?: boolean;
  label: string;
  multiline?: boolean;
  onChange: (v: string) => void;
  onDelete?: () => void;
  path?: string;
  value: string;
}) {
  return (
    <Field label={label} path={path} onDelete={onDelete}>
      {multiline ? (
        <textarea
          className={
            code
              ? "input min-h-44 resize-y font-mono text-xs leading-5"
              : "input min-h-24 resize-y leading-6"
          }
          spellCheck={!code}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

function ProgressHintsEditor({
  hints,
  importance,
  onAdd,
  onDelete,
  onImportanceChange,
  onPatch,
}: {
  hints: NodeProgressHint[];
  importance: DialogueNode["progress_hint_importance"];
  onAdd: () => void;
  onDelete: (index: number) => void;
  onImportanceChange: (v: DialogueNode["progress_hint_importance"]) => void;
  onPatch: (index: number, patch: Partial<NodeProgressHint>) => void;
}) {
  return (
    <div className="ide-subcard grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="font-mono text-xs font-semibold text-zinc-400">
            progress hints
          </h4>
          <p className="mt-1 text-xs text-zinc-500">
            Use the latest hint whose turn threshold has passed.
          </p>
        </div>
        <SelectInline
          options={PROGRESS_HINT_IMPORTANCES}
          value={importance}
          onChange={(v) => onImportanceChange(cleanImportance(v))}
        />
      </div>
      {hints.length ? (
        <div className="grid gap-2">
          {hints.map((hint, i) => (
            <div
              className="grid gap-2 rounded-md border border-white/10 bg-black/20 p-3"
              key={`${hint.paths.hint ?? "new"}:${i}`}
            >
              <div className="flex items-center justify-between gap-2">
                <label className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
                  <span className="shrink-0 font-mono uppercase">after turns</span>
                  <input
                    className="input h-8 w-20 py-1 text-xs"
                    min={1}
                    type="number"
                    value={hint.starts_after_turns}
                    onChange={(e) =>
                      onPatch(i, {
                        starts_after_turns: posInt(e.target.value, DEFAULT_HINT_START_TURNS),
                      })
                    }
                  />
                </label>
                <button
                  className="ide-button ide-button-danger px-2.5 py-1 text-xs"
                  onClick={() => onDelete(i)}
                  type="button"
                >
                  Delete
                </button>
              </div>
              <textarea
                className="input min-h-20 resize-y leading-6"
                placeholder="In-character hint direction"
                value={hint.text}
                onChange={(e) => onPatch(i, { text: e.target.value })}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="ide-empty">No progress hints.</p>
      )}
      <button className="ide-button ide-button-primary" onClick={onAdd} type="button">
        Add hint
      </button>
    </div>
  );
}

function SelectInline({
  onChange,
  options,
  value,
}: {
  onChange: (v: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <select
      className="input h-8 w-28 py-1 text-xs"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">unset</option>
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

function ReferenceMultiSelect({
  actionLabel,
  emptyText,
  onAdd,
  onRemove,
  options,
  selectedValues,
}: {
  actionLabel: string;
  emptyText: string;
  onAdd: (v: string) => Promise<void>;
  onRemove: (v: string) => Promise<void>;
  options: ReferenceOption[];
  selectedValues: string[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [pending, setPending] = useState("");
  const selectedOptions = selectedValues.map(
    (v) =>
      options.find((o) => o.value === v) ?? {
        description: "Missing reference",
        label: v,
        value: v,
      },
  );

  const toggle = async (v: string, shouldSelect: boolean) => {
    if (pending || !v.trim()) return;
    setPending(v);
    try {
      if (shouldSelect) await onAdd(v);
      else await onRemove(v);
    } finally {
      setPending("");
    }
  };

  return (
    <div className="overflow-hidden rounded-md border border-white/10 bg-black/20">
      <div className="flex min-h-11 items-start justify-between gap-3 px-3 py-2">
        <div className="flex max-h-24 min-w-0 flex-1 flex-wrap items-center gap-2 overflow-auto">
          {selectedOptions.length ? (
            selectedOptions.map((opt) => (
              <button
                aria-label={`Remove ${opt.value}`}
                className="inline-flex max-w-full items-center gap-2 rounded-md border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-left font-mono text-[11px] font-semibold text-cyan-100 transition hover:border-cyan-200/45 hover:bg-cyan-300/15 disabled:cursor-wait disabled:opacity-60"
                disabled={Boolean(pending)}
                key={opt.value}
                onClick={() => void toggle(opt.value, false)}
                title={opt.description}
                type="button"
              >
                <span className="truncate">{opt.label}</span>
                <span aria-hidden="true" className="text-cyan-100/60">
                  x
                </span>
              </button>
            ))
          ) : (
            <span className="py-1 text-xs text-zinc-500">{emptyText}</span>
          )}
        </div>
        <button
          aria-expanded={isOpen}
          className="ide-button shrink-0 px-2.5 py-1 text-xs"
          onClick={() => setIsOpen((c) => !c)}
          type="button"
        >
          {isOpen
            ? "Done"
            : selectedValues.length
              ? `${actionLabel} (${selectedValues.length})`
              : actionLabel}
        </button>
      </div>
      {isOpen && (
        <ReferenceOptionList
          busy={Boolean(pending)}
          onToggle={(v, sel) => void toggle(v, sel)}
          options={options}
          selectedValues={selectedValues}
        />
      )}
    </div>
  );
}

function RevealChunkGroup({
  children,
  count,
  subtitle,
  title,
  tone,
}: {
  children: ReactNode;
  count: number;
  subtitle: string;
  title: string;
  tone: "fact" | "stage" | "other";
}) {
  const cls = {
    fact: {
      border: "border-emerald-300/18",
      badge: "border-emerald-300/25 bg-emerald-300/10 text-emerald-100",
      marker: "bg-emerald-400",
    },
    stage: {
      border: "border-amber-300/20",
      badge: "border-amber-300/25 bg-amber-300/10 text-amber-100",
      marker: "bg-amber-400",
    },
    other: {
      border: "border-red-400/25",
      badge: "border-red-400/25 bg-red-500/10 text-red-100",
      marker: "bg-red-400",
    },
  }[tone];
  return (
    <section className={`rounded-lg border ${cls.border} bg-white/[0.035] p-3`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${cls.marker}`} />
            <h4 className="font-mono text-xs font-semibold uppercase tracking-wide text-zinc-200">
              {title}
            </h4>
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{subtitle}</p>
        </div>
        <span className={`rounded border px-2 py-1 font-mono text-[11px] ${cls.badge}`}>
          {count}
        </span>
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function RevealChunkCard({
  activeUntilOptions,
  chunk,
  onDeleteChunk,
  onDeleteReveal,
  onPatchChunk,
}: {
  activeUntilOptions: string[];
  chunk: NodeRevealChunk;
  onDeleteChunk: () => Promise<void>;
  onDeleteReveal: () => Promise<void>;
  onPatchChunk: (patch: {
    type?: string;
    text?: string;
    activeUntil?: string;
  }) => Promise<void>;
}) {
  const [busy, runDelete] = useConfirmedBusyAction();
  const isStage = chunk.type === "stage";
  const isFact = chunk.type === "fact";
  const badgeClass =
    chunk.type === "stage"
      ? "border-amber-300/25 bg-amber-300/10 text-amber-100"
      : chunk.type === "fact"
        ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
        : "border-red-400/25 bg-red-500/10 text-red-100";

  const cardClass = !chunk.exists
    ? "rounded-md border border-red-400/25 bg-red-500/10 p-3"
    : isStage
      ? "rounded-md border border-amber-300/16 bg-amber-300/[0.035] p-3"
      : isFact
        ? "rounded-md border border-emerald-300/16 bg-emerald-300/[0.035] p-3"
        : "ide-subcard";

  return (
    <article className={cardClass}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-zinc-300">
              {chunk.id || "missing id"}
            </span>
            <EditableSelectChip
              ariaLabel="Edit chunk type"
              className={badgeClass}
              disabled={busy || !chunk.exists}
              options={CHUNK_TYPES}
              value={chunk.type}
              onSave={(v) => onPatchChunk({ type: v })}
            />
            {(isStage || chunk.active_until) && (
              <EditableSelectChip
                allowEmpty
                ariaLabel="Edit active until"
                className="border-white/10 bg-white/[0.04] text-zinc-300 hover:border-amber-300/35 hover:text-amber-100"
                disabled={busy || !chunk.exists}
                emptyLabel="set until"
                options={activeUntilOptions}
                prefix="until "
                value={chunk.active_until}
                onSave={(v) => onPatchChunk({ activeUntil: v })}
              />
            )}
          </div>
          {!chunk.exists && (
            <p className="mt-2 text-xs text-red-200">
              This reveal references a missing knowledge chunk.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className="ide-button ide-button-danger px-2.5 py-1 text-xs disabled:opacity-50"
            disabled={busy}
            onClick={() =>
              runDelete(
                `Remove reveal reference ${chunk.id} from this node?`,
                onDeleteReveal,
              )
            }
            type="button"
          >
            Delete ref
          </button>
          <button
            className="ide-button ide-button-danger px-2.5 py-1 text-xs disabled:opacity-50"
            disabled={busy || !chunk.exists}
            onClick={() =>
              runDelete(
                `Delete knowledge chunk ${chunk.id} everywhere? This also removes reveal/public references.`,
                onDeleteChunk,
              )
            }
            type="button"
          >
            Delete chunk
          </button>
        </div>
      </div>
      {chunk.exists && (
        <ChunkValueEditor
          label={isStage ? "stage behavior" : isFact ? "fact text" : "chunk text"}
          path={chunk.paths.text}
          value={chunk.text}
          onSave={(v) => onPatchChunk({ text: v })}
        />
      )}
    </article>
  );
}

function ChunkValueEditor({
  label,
  onSave,
  path,
  value,
}: {
  label: string;
  onSave: (v: string) => Promise<void>;
  path?: string;
  value: string;
}) {
  const { dirty, draft, save, setDraft, status } = useSaveableDraft({
    onSave,
    resetKey: `${path ?? label}:${value}`,
    value,
  });
  return (
    <Field label={label} path={path}>
      <textarea
        className="input min-h-24 resize-y leading-6"
        value={draft}
        onBlur={save}
        onChange={(e) => setDraft(e.target.value)}
      />
      {dirty && (
        <p className="text-xs text-zinc-500">
          {status === "saving"
            ? "Saving..."
            : status === "error"
              ? "Save failed"
              : "Unsaved"}
        </p>
      )}
    </Field>
  );
}

function Field({
  children,
  label,
  onDelete,
  path,
}: {
  children: ReactNode;
  label: string;
  onDelete?: () => void;
  path?: string;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs font-medium text-zinc-500">{label}</span>
        {onDelete && (
          <button
            className="text-xs text-red-300 transition hover:text-red-100 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!path}
            onClick={onDelete}
            type="button"
          >
            Delete
          </button>
        )}
      </span>
      {children}
    </label>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanImportance(v: string): DialogueNode["progress_hint_importance"] {
  return PROGRESS_HINT_IMPORTANCES.includes(v)
    ? (v as DialogueNode["progress_hint_importance"])
    : "med";
}

function posInt(v: string, fallback: number): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const GENERATED_CHUNK_PATTERN = /^([A-Z]{2,4})_N\d+_(FACT|STAGE)_(\d+)$/;
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sh", ы: "y", э: "e", ю: "yu", я: "ya",
};
const TITLE_WORDS = new Set(["капитан", "детектив", "лейтенант", "сержант", "доктор"]);

function nextChunkId(
  characterName: string | null | undefined,
  nodeId: string | null | undefined,
  chunkType: string | null | undefined,
  chunks: KnowledgeChunk[],
): string {
  const prefix = inferPrefix(characterName, chunks);
  const nId = (nodeId ?? "").trim();
  const type = (chunkType ?? "").trim().toUpperCase() === "STAGE" ? "STAGE" : "FACT";
  if (!prefix || !nId) return "";
  const usedIds = new Set(chunks.map((c) => c.id));
  const re = new RegExp(
    `^${escRe(prefix)}_${escRe(nId)}_${type}_(\\d+)$`,
  );
  const maxIdx = chunks.reduce((max, c) => {
    const m = re.exec(c.id);
    return m ? Math.max(max, parseInt(m[1] ?? "0", 10) || 0) : max;
  }, 0);
  let idx = maxIdx + 1;
  let candidate = `${prefix}_${nId}_${type}_${String(idx).padStart(3, "0")}`;
  while (usedIds.has(candidate)) {
    idx++;
    candidate = `${prefix}_${nId}_${type}_${String(idx).padStart(3, "0")}`;
  }
  return candidate;
}

function inferPrefix(
  name: string | null | undefined,
  chunks: KnowledgeChunk[],
): string {
  const counts = new Map<string, number>();
  for (const c of chunks) {
    const m = GENERATED_CHUNK_PATTERN.exec(c.id);
    if (m?.[1]) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return top ?? namePrefix(name);
}

function namePrefix(name: string | null | undefined): string {
  const safe = (name ?? "").trim();
  const word =
    safe
      .split(/\s+/)
      .find((w) => !TITLE_WORDS.has(w.toLowerCase())) ?? safe;
  const letters = transliterate(word)
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
  return (letters || "CH").slice(0, 2).padEnd(2, "X");
}

function transliterate(v: string): string {
  return [...v].map((c) => CYRILLIC[c.toLowerCase()] ?? c).join("");
}

function escRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
