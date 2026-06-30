import {
  Component,
  type ErrorInfo,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { CharacterContextPanel, InspectorPanel } from "./editor";
import { GraphCanvas } from "./graph";
import { nextNodeId } from "./nodeId";
import { useGraphStore } from "./store";

const LEFT_MIN = 360;
const LEFT_MAX = 760;
const RIGHT_MIN = 420;
const RIGHT_MAX = 980;
const PANEL_COLLAPSE_THRESHOLD = 96;

export default function App() {
  return (
    <ErrorBoundary>
      <CharacterEditorApp />
    </ErrorBoundary>
  );
}

function CharacterEditorApp() {
  const loading = useGraphStore((s) => s.loading);
  const error = useGraphStore((s) => s.error);
  const fileName = useGraphStore((s) => s.fileName);
  const [leftWidth, setLeftWidth] = useState(560);
  const [rightWidth, setRightWidth] = useState(640);

  const gridTemplateColumns = [
    `${leftWidth}px`,
    "8px",
    "minmax(280px, 1fr)",
    "8px",
    `${rightWidth}px`,
  ].join(" ");

  const startResize = (side: "left" | "right", event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startLeft = leftWidth;
    const startRight = rightWidth;

    const onMove = (e: globalThis.PointerEvent) => {
      const delta = e.clientX - startX;
      if (side === "left") {
        setLeftWidth(panelWidth(startLeft + delta, LEFT_MIN, LEFT_MAX));
      } else {
        setRightWidth(panelWidth(startRight - delta, RIGHT_MIN, RIGHT_MAX));
      }
    };

    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <main className="ide-shell">
      <Toolbar />
      {fileName === null ? (
        <LandingScreen />
      ) : (
        <section className="ide-layout ide-enter" style={{ gridTemplateColumns }}>
          <PanelSlot visible={leftWidth > 0}>
            <CharacterContextPanel />
          </PanelSlot>
          <ResizeHandle
            label="Resize character panel"
            onPointerDown={(e) => startResize("left", e)}
          />
          <div className="ide-graph-frame">
            {loading && (
              <div className="absolute left-4 top-4 z-10 rounded-md border border-white/10 bg-black/60 px-3 py-2 text-sm text-zinc-200 backdrop-blur-xl">
                Loading graph...
              </div>
            )}
            {error && (
              <div className="absolute left-4 top-4 z-10 rounded-md border border-red-400/30 bg-red-500/15 px-3 py-2 text-sm text-red-100 backdrop-blur-xl">
                {error}
              </div>
            )}
            <GraphCanvas />
          </div>
          <ResizeHandle
            label="Resize inspector panel"
            onPointerDown={(e) => startResize("right", e)}
          />
          <PanelSlot visible={rightWidth > 0}>
            <InspectorPanel />
          </PanelSlot>
        </section>
      )}
    </main>
  );
}

function Toolbar() {
  const {
    fileName,
    graph,
    graphExtrasVisible,
    toggleGraphExtras,
    openFile,
    openEvidenceFile,
    saveFile,
    addNode,
    evidenceCatalog,
    evidenceFileName,
  } = useGraphStore();
  const [createOpen, setCreateOpen] = useState(false);
  const createWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!createOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (createWrapRef.current && !createWrapRef.current.contains(event.target as Node)) {
        setCreateOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCreateOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [createOpen]);

  return (
    <header className="ide-topbar relative z-50">
      <div className="ide-brand-mark">JSON</div>
      {fileName && (
        <span className="truncate font-mono text-sm text-zinc-300">{fileName}</span>
      )}
      <div className="flex gap-2">
        {fileName !== null && (
          <button
            aria-pressed={graphExtrasVisible}
            className={graphExtrasVisible ? "chip chip-active" : "chip"}
            onClick={toggleGraphExtras}
            title={
              graphExtrasVisible
                ? "Hide evidence and update links"
                : "Show evidence and update links"
            }
            type="button"
          >
            Evidence / Updates
          </button>
        )}
      </div>
      <div className="ml-auto flex gap-2">
        {fileName !== null && (
          <div ref={createWrapRef} className="relative">
            <button
              aria-expanded={createOpen}
              className="ide-button ide-button-primary"
              disabled={!graph}
              onClick={() => setCreateOpen((open) => !open)}
              type="button"
            >
              + New node
            </button>
            {createOpen && graph && (
              <CreateNodePopover
                defaultNodeId={nextNodeId(graph.nodes.map((node) => node.id))}
                onClose={() => setCreateOpen(false)}
                onCreate={addNode}
              />
            )}
          </div>
        )}
        <button
          className="ide-button"
          type="button"
          onClick={() => void openFile()}
        >
          Open JSON
        </button>
        <button
          className="ide-button"
          type="button"
          onClick={() => void openEvidenceFile()}
          title={
            evidenceFileName
              ? `Loaded ${evidenceFileName} (${evidenceCatalog.length} items)`
              : "Load a global evidence.json catalog"
          }
        >
          {evidenceFileName
            ? `Evidence: ${evidenceCatalog.length}`
            : "Load evidence"}
        </button>
        {fileName !== null && (
          <button
            className="ide-button ide-button-primary"
            type="button"
            onClick={saveFile}
          >
            Save JSON
          </button>
        )}
      </div>
    </header>
  );
}

function CreateNodePopover({
  defaultNodeId,
  onClose,
  onCreate,
}: {
  defaultNodeId: string;
  onClose: () => void;
  onCreate: (nodeId: string, title?: string) => Promise<void>;
}) {
  const [nodeId, setNodeId] = useState(defaultNodeId);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nodeIdRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nodeIdRef.current?.focus();
    nodeIdRef.current?.select();
  }, []);

  const submit = async () => {
    const id = nodeId.trim();
    if (!id || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(id, title.trim() || undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="absolute right-0 top-full z-[1000] mt-2 w-80 rounded-lg border border-white/15 bg-[#0d0f13] p-4 shadow-2xl shadow-black/60">
      <h2 className="text-sm font-semibold text-zinc-50">Create node</h2>
      <p className="mt-1 text-xs leading-5 text-zinc-500">
        Adds a new node to the disclosure graph.
      </p>
      <div className="mt-3 grid gap-3">
        <label className="grid gap-1.5 text-sm">
          <span className="font-mono text-xs font-medium text-zinc-500">node_id</span>
          <input
            ref={nodeIdRef}
            className="input"
            placeholder="N5"
            value={nodeId}
            onChange={(event) => setNodeId(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
          />
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="font-mono text-xs font-medium text-zinc-500">title (optional)</span>
          <input
            className="input"
            placeholder="Node title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
          />
        </label>
        {error && (
          <p className="rounded-md border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-100">
            {error}
          </p>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="ide-button" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="ide-button ide-button-primary disabled:opacity-50"
          disabled={!nodeId.trim() || busy}
          onClick={submit}
          type="button"
        >
          {busy ? "Creating…" : "Create node"}
        </button>
      </div>
    </div>
  );
}

function LandingScreen() {
  const openFile = useGraphStore((s) => s.openFile);
  const openEvidenceFile = useGraphStore((s) => s.openEvidenceFile);
  const evidenceCatalog = useGraphStore((s) => s.evidenceCatalog);
  const evidenceFileName = useGraphStore((s) => s.evidenceFileName);
  const error = useGraphStore((s) => s.error);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <div className="grid max-w-md gap-4 text-center">
        <h1 className="text-3xl font-semibold text-zinc-100">Character JSON Editor</h1>
        <p className="text-base leading-7 text-zinc-400">
          Load a character JSON file to view and edit the disclosure graph,
          knowledge chunks, and evidence catalog. Changes are applied in memory;
          download when done.
        </p>
        {error && (
          <p className="rounded-md border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {error}
          </p>
        )}
        <button
          className="ide-button ide-button-primary mx-auto mt-2 px-6 py-3 text-base"
          type="button"
          onClick={() => void openFile()}
        >
          Open JSON file
        </button>
        <button
          className="ide-button mx-auto px-5 py-2.5 text-sm"
          type="button"
          onClick={() => void openEvidenceFile()}
        >
          {evidenceFileName
            ? `Evidence loaded: ${evidenceFileName} (${evidenceCatalog.length})`
            : "Load evidence catalog (optional)"}
        </button>
        <p className="text-xs text-zinc-600">
          Only <code className="text-zinc-400">.json</code> files are accepted. Nothing is
          uploaded — the file stays in your browser. Load{" "}
          <code className="text-zinc-400">evidence.json</code> to resolve evidence titles
          and descriptions.
        </p>
      </div>
    </div>
  );
}

function PanelSlot({ children, visible }: { children: ReactNode; visible: boolean }) {
  return (
    <div className="min-h-0 overflow-hidden">{visible ? children : null}</div>
  );
}

function ResizeHandle({
  label,
  onPointerDown,
}: {
  label: string;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      aria-label={label}
      className="ide-resize-handle group"
      role="separator"
      onPointerDown={onPointerDown}
    >
      <div className="ide-resize-line" />
      <div className="ide-resize-grip" />
    </div>
  );
}

function panelWidth(value: number, min: number, max: number): number {
  if (value <= PANEL_COLLAPSE_THRESHOLD) return 0;
  return Math.max(min, Math.min(max, value));
}

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="ide-shell flex items-center justify-center p-8">
          <div className="max-w-xl rounded-lg border border-red-400/25 bg-red-500/10 p-5 shadow-2xl shadow-black/30">
            <h1 className="text-lg font-semibold">Frontend runtime error</h1>
            <p className="mt-3 font-mono text-sm text-red-100">{this.state.error}</p>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
