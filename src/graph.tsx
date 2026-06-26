import cytoscape, { Core } from "cytoscape";
import type { EdgeSingular, ElementDefinition, NodeSingular } from "cytoscape";
import { useEffect, useMemo, useRef } from "react";

import { useGraphStore } from "./store";

type NodePosition = { x: number; y: number };
type PositionCache = Record<string, NodePosition>;
type RouteNode = {
  id: string;
  position: NodePosition;
  radius: number;
};

const ROUTE_MIN_DISTANCE = 62;
const ROUTE_MAX_DISTANCE = 230;
const ROUTE_SIDE_SCAN = 210;
const ROUTE_STRAIGHT_SCORE_LIMIT = 0.15;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function GraphCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const fileNameRef = useRef(useGraphStore.getState().fileName);
  const { graph, graphExtrasVisible, search, fileName, selectedId, select } = useGraphStore();

  useEffect(() => {
    fileNameRef.current = fileName;
  }, [fileName]);

  const elements = useMemo(() => {
    if (!graph) return [];
    const candidateElements = graph.cytoscape.filter((element) => {
      const layer = String(element.data?.layer || "");
      if (!isLayerVisible(layer, graphExtrasVisible)) return false;
      if (!search.trim()) return true;
      const haystack = JSON.stringify(element.data || {}).toLowerCase();
      return haystack.includes(search.toLowerCase());
    });
    const visibleNodeIds = new Set(
      candidateElements
        .filter((element) => element.group === "nodes")
        .map((element) => String(element.data?.id)),
    );
    return candidateElements.filter((element) => {
      if (element.group !== "edges") return true;
      return visibleNodeIds.has(String(element.data?.source)) && visibleNodeIds.has(String(element.data?.target));
    });
  }, [graph, graphExtrasVisible, search]);

  useEffect(() => {
    if (!containerRef.current || cyRef.current) return;
    cyRef.current = cytoscape({
      container: containerRef.current,
      wheelSensitivity: 0.2,
      style: [
        {
          selector: "node",
          style: {
            shape: "round-rectangle",
            "background-color": "data(color)",
            "border-color": "#1f2937",
            "border-width": "1.5px",
            label: "data(label)",
            color: "#f4f4f5",
            "font-size": "11px",
            "font-weight": 600,
            "text-valign": "center",
            "text-halign": "center",
            "text-wrap": "wrap",
            "text-max-width": "132px",
            "text-outline-color": "#07090c",
            "text-outline-width": "2px",
            width: "148px",
            height: "56px",
          },
        },
        {
          selector: "node.entry",
          style: {
            "border-color": "#22d3ee",
            "border-width": "2.5px",
          },
        },
        {
          selector: "node.branch",
          style: {
            "border-color": "#f59e0b",
          },
        },
        {
          selector: "node.terminal",
          style: {
            "border-color": "#22c55e",
          },
        },
        {
          selector: "node.evidence",
          style: {
            shape: "diamond",
            "background-color": "#0e7490",
            "border-color": "#67e8f9",
            "border-width": "1.5px",
            "font-size": "11px",
            "font-weight": 600,
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 8,
            "text-max-width": "130px",
            width: "data(size)",
            height: "data(size)",
          },
        },
        {
          selector: "node.parked-evidence",
          style: {
            opacity: 0.58,
          },
        },
        {
          selector: "node.condition",
          style: {
            shape: "round-rectangle",
            "background-color": "#3f3f46",
            width: "74px",
            height: "34px",
          },
        },
        {
          selector: "edge",
          style: {
            width: "2.2px",
            "line-color": "#475569",
            "target-arrow-color": "#475569",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "control-point-step-size": 34,
            "line-cap": "round",
            opacity: 0.62,
            "z-index": 2,
          },
        },
        {
          selector: "edge.step-edge",
          style: {
            "curve-style": "straight",
            opacity: 0.78,
          },
        },
        {
          selector: "edge.long-edge",
          style: {
            "curve-style": "unbundled-bezier",
            "control-point-distances": "data(curveDistance)",
            "control-point-weights": 0.44,
            width: "1.8px",
            opacity: 0.48,
          },
        },
        {
          selector: "edge.cross-lane-edge",
          style: {
            "curve-style": "unbundled-bezier",
            "control-point-distances": "data(curveDistance)",
            "control-point-weights": 0.42,
            "line-color": "#67e8f9",
            "target-arrow-color": "#67e8f9",
            width: "2.4px",
            opacity: 0.72,
          },
        },
        {
          selector: "edge.compound-edge",
          style: {
            "line-style": "dashed",
            opacity: 0.58,
          },
        },
        {
          selector: "edge.conditional-edge",
          style: {
            label: "data(shortCondition)",
            "font-size": "10px",
            color: "#cbd5e1",
            "text-background-color": "#0b1117",
            "text-background-opacity": 0.88,
            "text-background-padding": "3px",
            "text-rotation": "autorotate",
          },
        },
        {
          selector: "edge.edge-hover, edge.focus-edge",
          style: {
            label: "data(edgeHint)",
            width: "4px",
            opacity: 1,
            "line-color": "#fbbf24",
            "target-arrow-color": "#fbbf24",
            "text-background-color": "#09090b",
            "text-background-opacity": 0.95,
            "text-background-padding": "4px",
            "text-border-color": "#fbbf24",
            "text-border-width": 1,
            color: "#fef3c7",
            "font-size": "11px",
            "text-rotation": "autorotate",
            "z-index": 30,
          },
        },
        {
          selector: "node.focus-node",
          style: {
            "border-color": "#fbbf24",
            "border-width": "3px",
            "z-index": 40,
          },
        },
        {
          selector: ".dimmed",
          style: {
            opacity: 0.18,
          },
        },
        {
          selector: "edge.evidence-edge",
          style: {
            "line-color": "#0891b2",
            "target-arrow-color": "#0891b2",
            "line-style": "dashed",
            "curve-style": "straight",
            opacity: 0.7,
          },
        },
        {
          selector: "edge.update-edge",
          style: {
            "line-color": "#f43f5e",
            "target-arrow-color": "#f43f5e",
            "line-style": "dotted",
            "curve-style": "straight",
            opacity: 0.82,
          },
        },
        {
          selector: "edge.routed-edge",
          style: {
            "curve-style": "unbundled-bezier",
            "control-point-distances": "data(curveDistance)",
            "control-point-weights": "data(curveWeight)",
          },
        },
        {
          selector: ":selected",
          style: {
            "border-color": "#fbbf24",
            "border-width": "3px",
            "line-color": "#fbbf24",
            "target-arrow-color": "#fbbf24",
          },
        },
      ],
      elements: [],
    });

    cyRef.current.on("tap", "node", (event) => {
      select(event.target.id());
    });
    cyRef.current.on("tap", (event) => {
      if (event.target === cyRef.current) select(null);
    });
    cyRef.current.on("mouseover", "edge", (event) => {
      event.target.addClass("edge-hover");
    });
    cyRef.current.on("mouseout", "edge", (event) => {
      event.target.removeClass("edge-hover");
    });
    cyRef.current.on("dragfree", "node", () => {
      saveNarrativePositions(fileNameRef.current ?? "", cyRef.current);
      routeGraphEdges(cyRef.current);
    });
  }, [select]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().remove();
    cy.add(cloneElements(elements));
  }, [elements]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || elements.length === 0) return;

    let frame = window.requestAnimationFrame(() => {
      runNarrativeLayout(cy, elements, fileName ?? "");
      routeGraphEdges(cy);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      cy.stop();
    };
  }, [elements, fileName]);

  useEffect(() => {
    const container = containerRef.current;
    const cy = cyRef.current;
    if (!container || !cy) return;

    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        cy.resize();
      });
    });
    observer.observe(container);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("dimmed focus-node focus-edge");
    cy.nodes().unselect();
    if (!selectedId) return;

    const node = cy.getElementById(selectedId);
    if (!node.length) return;

    const connectedEdges = node.connectedEdges();
    const connectedNodes = connectedEdges.connectedNodes();
    const focused = connectedEdges.union(connectedNodes);
    cy.elements().not(focused).addClass("dimmed");
    connectedEdges.addClass("focus-edge");
    node.addClass("focus-node");
    node.select();
  }, [selectedId]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function runNarrativeLayout(cy: Core, elements: ElementDefinition[], fileName: string) {
  cy.stop();
  cy.resize();

  const cachedPositions = loadNarrativePositions(fileName);
  const positions = new Map(
    elements
      .filter((element) => element.group === "nodes" && element.position && element.data?.id)
      .map((element) => {
        const id = String(element.data?.id);
        return [id, cachedPositions[id] ?? element.position];
      }),
  );

  cy.nodes().forEach((node) => {
    const position = positions.get(node.id());
    if (position) node.position(position);
  });

  cy.layout({
    name: "preset",
    fit: true,
    padding: 56,
    animate: false,
  } as cytoscape.LayoutOptions).run();
}

function routeGraphEdges(cy: Core | null) {
  if (!cy) return;

  const nodes = cy.nodes().map((node) => routeNode(node));
  const parallelCounts = new Map<string, number>();
  const parallelIndexes = new Map<string, number>();

  cy.edges().forEach((edge) => {
    if (edge.data("layer") !== "dialogue") {
      edge.removeClass("routed-edge");
      return;
    }
    const key = edgePairKey(edge);
    parallelCounts.set(key, (parallelCounts.get(key) ?? 0) + 1);
  });

  cy.edges().forEach((edge) => {
    if (edge.data("layer") !== "dialogue") {
      edge.removeClass("routed-edge");
      return;
    }
    const source = edge.source();
    const target = edge.target();
    if (!source.length || !target.length || source.same(target)) {
      edge.removeClass("routed-edge");
      return;
    }

    const key = edgePairKey(edge);
    const parallelIndex = parallelIndexes.get(key) ?? 0;
    parallelIndexes.set(key, parallelIndex + 1);
    const parallelCount = parallelCounts.get(key) ?? 1;
    const route = edgeRoute(
      source.position(),
      target.position(),
      nodes.filter((node) => node.id !== source.id() && node.id !== target.id()),
      parallelIndex,
      parallelCount,
    );

    if (!route.shouldRoute) {
      edge.removeClass("routed-edge");
      return;
    }

    edge.data("curveDistance", route.curveDistance);
    edge.data("curveWeight", 0.5);
    edge.addClass("routed-edge");
  });
}

function routeNode(node: NodeSingular): RouteNode {
  const position = node.position();
  return {
    id: node.id(),
    position: { x: position.x, y: position.y },
    radius: Math.max(node.outerWidth(), node.outerHeight()) / 2,
  };
}

function edgeRoute(
  source: NodePosition,
  target: NodePosition,
  nodes: RouteNode[],
  parallelIndex: number,
  parallelCount: number,
): { curveDistance: number; shouldRoute: boolean } {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return { curveDistance: 0, shouldRoute: false };

  const baseDistance = clamp(length * 0.24, ROUTE_MIN_DISTANCE, ROUTE_MAX_DISTANCE);
  const leftScore = routeSideScore(source, target, nodes, 1);
  const rightScore = routeSideScore(source, target, nodes, -1);
  const preferredSign = leftScore <= rightScore ? 1 : -1;
  const bestScore = Math.min(leftScore, rightScore);
  const fanOffset = parallelFanOffset(parallelIndex, parallelCount);
  const shouldRoute = (
    parallelCount > 1
    || bestScore > ROUTE_STRAIGHT_SCORE_LIMIT
    || Math.abs(dy) > 44
    || Math.abs(dx) > 320
  );

  return {
    curveDistance: Math.round(preferredSign * (baseDistance + fanOffset)),
    shouldRoute,
  };
}

function routeSideScore(source: NodePosition, target: NodePosition, nodes: RouteNode[], sideSign: 1 | -1): number {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  const nx = -dy / length;
  const ny = dx / length;
  const vx = dx / length;
  const vy = dy / length;

  return nodes.reduce((score, node) => {
    const relativeX = node.position.x - source.x;
    const relativeY = node.position.y - source.y;
    const projection = (relativeX * vx + relativeY * vy) / length;
    if (projection < -0.12 || projection > 1.12) return score;

    const signedDistance = relativeX * nx + relativeY * ny;
    if (signedDistance === 0 || Math.sign(signedDistance) !== sideSign) return score;

    const distance = Math.abs(signedDistance);
    const corridor = ROUTE_SIDE_SCAN + node.radius;
    if (distance > corridor) return score;

    const middleBoost = projection >= 0 && projection <= 1 ? 0.5 : 0;
    const collisionBoost = distance < node.radius + 38 ? 2.25 : 0;
    return score + 1 + ((corridor - distance) / corridor) + middleBoost + collisionBoost;
  }, 0);
}

function parallelFanOffset(index: number, count: number): number {
  if (count <= 1) return 0;
  const midpoint = (count - 1) / 2;
  return Math.abs(index - midpoint) * 28;
}

function edgePairKey(edge: EdgeSingular): string {
  return `${edge.source().id()}->${edge.target().id()}`;
}

function cloneElements(elements: ElementDefinition[]): ElementDefinition[] {
  return elements.map((element) => ({
    ...element,
    data: element.data ? { ...element.data } : element.data,
    position: element.position ? { ...element.position } : element.position,
    classes: element.classes,
  }));
}

function positionCacheKey(fileName: string) {
  return `narrative-node-positions:v4:${fileName || "default"}`;
}

function isLayerVisible(layer: string, graphExtrasVisible: boolean): boolean {
  if (layer === "dialogue") return true;
  if (layer === "evidence" || layer === "updates") return graphExtrasVisible;
  return false;
}

function loadNarrativePositions(fileName: string): PositionCache {
  try {
    const raw = window.localStorage.getItem(positionCacheKey(fileName));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PositionCache;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveNarrativePositions(fileName: string, cy: Core | null) {
  if (!cy) return;

  const positions: PositionCache = { ...loadNarrativePositions(fileName) };
  cy.nodes().forEach((node) => {
    const position = node.position();
    positions[node.id()] = { x: position.x, y: position.y };
  });

  try {
    window.localStorage.setItem(positionCacheKey(fileName), JSON.stringify(positions));
  } catch {
    // localStorage can be unavailable in private or restricted browser contexts.
  }
}
