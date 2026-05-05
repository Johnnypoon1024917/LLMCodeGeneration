// webview-ui/src/views/MapGraph.tsx
//
// M-3 fix: lazy-loadable wrapper around `react-force-graph-3d`.
//
// Why this file exists: `react-force-graph-3d` pulls in `three.js`,
// which is ~600 KB minified and ~150 KB gzipped. Most users open the
// chat (Vibe) tab, not the Map tab — paying that bundle cost on every
// extension load is waste. By extracting the graph into its own module
// and importing it via `React.lazy(() => import('./MapGraph'))`, the
// chunk only loads when the Map tab is actually rendered. The chat UX
// pays nothing for a feature it never uses.
//
// Default export is required for React.lazy. Props mirror the subset
// of ForceGraph3D props that App.tsx passes — keep this surface tight;
// growing it defeats the lazy-loading boundary.
//
// This module deliberately has no side effects beyond rendering. No
// imports from App.tsx, no global state. The parent owns visualGraphData
// (memoized in App) and onNodeClick.
//
// V2.0 polish (2026-05): added onNodeDoubleClick + improved visuals.
// react-force-graph-3d doesn't ship a native double-click event, so
// we implement it with a click-timer pattern (250 ms threshold).

import React, { useRef, useCallback } from 'react';
import ForceGraph3D from 'react-force-graph-3d';

interface MapGraphLink {
    source: string | { id: string };
    target: string | { id: string };
    color?: string;
    isSemantic?: boolean;
    weight?: number;
}

interface MapGraphNode {
    id: string;
    name?: string;
    group?: string;
    val?: number;
}

export interface MapGraphProps {
    width: number;
    height: number;
    graphData: { nodes: MapGraphNode[]; links: MapGraphLink[] };
    /** Used as React key on the underlying ForceGraph3D so changing
     *  map type (codeMap vs traceability) re-mounts cleanly. */
    mapKey: string;
    /** `group` is intentionally `string | undefined` (not `group?: string`)
     *  so callers can forward the upstream value verbatim under
     *  `exactOptionalPropertyTypes`. The omitted-vs-explicit-undefined
     *  distinction is meaningless for this prop. */
    onNodeClick: (node: { id: string; group: string | undefined }) => void;
    /** Optional double-click handler — fired when the same node is
     *  clicked twice within 250 ms. Use case: side-panel open on single
     *  click, file-in-editor jump on double-click. */
    onNodeDoubleClick?: (node: { id: string; group: string | undefined }) => void;
}

/**
 * Click-timer threshold for distinguishing single vs double clicks.
 * 250 ms matches typical OS conventions and is comfortable for
 * accidental-double-click avoidance.
 */
const DOUBLE_CLICK_THRESHOLD_MS = 250;

const MapGraph: React.FC<MapGraphProps> = ({ width, height, graphData, mapKey, onNodeClick, onNodeDoubleClick }) => {
    // Click-timer state for double-click detection. We track the
    // most-recently-clicked node id and the pending timer. If the
    // same node is clicked again before the timer fires, it's a
    // double-click; otherwise the single-click handler runs at
    // timer expiration.
    const lastClickRef = useRef<{ id: string; timer: number | null }>({ id: '', timer: null });

    const handleNodeClick = useCallback((node: MapGraphNode) => {
        const payload = { id: node.id, group: node.group };
        const last = lastClickRef.current;

        // Same-node second click within threshold → double-click.
        if (last.id === node.id && last.timer !== null) {
            window.clearTimeout(last.timer);
            lastClickRef.current = { id: '', timer: null };
            if (onNodeDoubleClick) {
                onNodeDoubleClick(payload);
                return;
            }
            // Fall through to single-click if no double-click handler.
        }

        // First click (or a different node from the prior pending click).
        // Cancel any pending single-click for the previous node.
        if (last.timer !== null) {
            window.clearTimeout(last.timer);
        }

        const timerId = window.setTimeout(() => {
            onNodeClick(payload);
            lastClickRef.current = { id: '', timer: null };
        }, DOUBLE_CLICK_THRESHOLD_MS);

        lastClickRef.current = { id: node.id, timer: timerId };
    }, [onNodeClick, onNodeDoubleClick]);

    return (
        <ForceGraph3D
            key={mapKey}
            width={width}
            height={height}
            graphData={graphData}
            nodeAutoColorBy="group"
            nodeLabel="name"
            linkDirectionalArrowLength={4}
            linkDirectionalArrowRelPos={1}
            linkWidth={(link: MapGraphLink) => (link.isSemantic ? 0.5 : 1.5)}
            linkDirectionalParticles={(link: MapGraphLink) => (link.isSemantic ? 3 : 0)}
            linkDirectionalParticleWidth={2}
            linkDirectionalParticleSpeed={0.005}
            linkColor={(link: MapGraphLink) => link.color ?? 'rgba(255,255,255,0.5)'}
            nodeVal="val"
            // Slightly lighter background than the previous #0d1117 —
            // matches VS Code's "deep dark" panel chrome more closely
            // and avoids the harsh contrast that read as "different
            // app" against the rest of the webview.
            backgroundColor="#0a0d12"
            // Brighter node color and slight opacity bump so single
            // nodes pop against the dark background. nodeAutoColorBy
            // still drives per-group hue, this just lifts the floor.
            nodeOpacity={0.92}
            // Resolution bump for crisper rendering at typical desktop
            // zoom levels — minimal performance cost (file-level
            // graphs rarely exceed 200 nodes).
            nodeResolution={16}
            onNodeClick={handleNodeClick}
        />
    );
};

export default MapGraph;