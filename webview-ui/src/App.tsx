import React, { useState, useEffect, useRef, useMemo, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import './App.css';
import ReactMarkdown from 'react-markdown';
import { advanceAutonomyQueue, buildInitialAutonomyQueue } from './autonomyQueue';
import {
    aggregateThinkingState,
    bulkToggleFromState,
    type ThinkingModeFlags,
} from './thinkingModeState';
// M-3: ForceGraph3D pulls in three.js (~600 KB / ~150 KB gzipped).
// Lazy-load it so the chat (Vibe) tab — which most users open and
// nothing else — never pays that cost. The chunk only loads on first
// Map tab render. See views/MapGraph.tsx for the wrapper.
const MapGraph = lazy(() => import('./views/MapGraph'));
// PR 1.3: new shell layout. Rail replaces the horizontal tab bar,
// SecurityStrip is the always-visible gate-status header. The
// existing per-tab content stays unchanged for now — it's just
// rendered inside AppShell instead of the legacy app-wrapper div.
import { AppShell } from './layout/AppShell';
import { Rail } from './layout/Rail';
import { SecurityStrip, type SecurityStatus } from './layout/SecurityStrip';
// PR 2.1: Workspace view components — IdleState (empty-state) and
// Message (normal/compacted variants). Per-task plans/tool cards
// stay inline in App.tsx until PR 2.2.
import { IdleState } from './views/workspace/IdleState';
import { Message as MessageView } from './views/workspace/Message';
// PR 2.3: Bash approval card (extracted from inline JSX).
import { BashApprovalCard } from './views/workspace/BashApprovalCard';
// PR 2.4: Right panel + audit log.
import { usePanel } from './state/usePanel';
import { useAuditLog } from './state/useAuditLog';
import { AuditLogPanel } from './views/audit/AuditLogPanel';
// PR 3.1: Spec workflow — phase stepper + EARS helper.
import { PhaseStepper, type PhaseState as PhaseStateForStepper } from './views/specs/PhaseStepper';
import { EarsHelper, insertAtCursor } from './views/specs/EarsHelper';
// PR 3.2: hooks panel.
import { useHooks } from './state/useHooks';
import { HooksPanel } from './views/hooks/HooksPanel';
import { useMcp } from './state/useMcp';
import { McpPanel } from './views/mcp/McpPanel';
// P3.1 panel: diagnostics — session telemetry, token breakdown, startup phases.
import { useDiagnostics } from './state/useDiagnostics';
import { DiagnosticsPanel } from './views/diagnostics/DiagnosticsPanel';
// PR 3.3: steering rules panel.
import { useSteering } from './state/useSteering';
import { SteeringPanel } from './views/steering/SteeringPanel';
import { log } from './utils/log';
import { parseHostMessage } from './messages/protocol';
import { FileChip } from './components/FileChip';
import { ErrorBanner } from './components/ErrorBanner';
import { CommandCard } from './components/CommandCard';
import { WorkingBar } from './components/WorkingBar';
// Component 2B-4: tool-call card rendering and state management.
import { ToolCallCard } from './components/ToolCallCard';
import { HookFireCard } from './components/HookFireCard';
import { applyToolEvent, type ToolCallState, type ToolLifecycleEvent } from './toolEvents';
import { applyHookEvent, sortedHookFires, type HookFireState, type HookLifecycleEvent } from './hookEvents';
import {
    // Existing icons (replaces the hand-rolled SVGs below)
    User as IconUser,
    Bot as IconNexus,
    Play as IconPlay,
    Check as IconCheck,
    ArrowUp as IconUpArrow,
    Brain as IconBrain,
    Loader2 as IconLoader,
    Eye as IconEye,
    Plus as IconPlus,
    Trash2 as IconTrash,
    Search as IconSearch,
    BookOpen as IconRead,
    Code as IconCode,
    AlertTriangle as IconAlert,
    Wrench as IconWrench,
    CheckCircle as IconCheckCircle,
    Box as IconBuild,
    RotateCw as IconRefresh,
    // New icons for the emoji replacement work (T2)
    FileText as IconFile,
    ClipboardList as IconClipboard,
    Link as IconLink,
    AlertCircle as IconWarning,
    Wand2 as IconWand,
    Square as IconStop,
    RotateCcw as IconRestart,
    Sparkles as IconSparkles,
    Zap as IconZap,
    Save as IconSave,
    FlaskConical as IconFlask,
    Archive as IconArchive,
    Edit3 as IconEdit,
    ExternalLink as IconExternalLink,
    XCircle as IconXCircle,
    Undo2 as IconUndo,
    FilePen as IconFilePen
} from 'lucide-react';

const vscode = (window as any).acquireVsCodeApi();
let chatTokenBuffer = "";
let lastChatUpdate = Date.now();
let reasoningTokenBuffer = "";
let lastReasoningUpdate = Date.now();

// Exported for unit testing. Used internally by App() but the function
// is pure and string-shaped so it's testable in isolation.
//
// L-3 hardening: this function uses regex-based tag parsing because
// it's hot-path on every assistant message. A real XML parser would
// be more correct but adds 30-50KB and a parser doesn't help us much
// — the model emits these tags inconsistently, with malformed
// attributes and unclosed tags being normal. We deliberately tolerate
// malformed input by:
//
//   1. Wrapping the body in try/catch — a bad tag should not blank
//      the chat panel; degrading to "show the original text" is the
//      right failure mode.
//   2. Capping input length. Without a cap, a malformed tag in a
//      multi-megabyte stream can trigger pathological regex backtracking
//      and freeze the UI thread for seconds.
//   3. Refusing non-string input rather than crashing on .replace().
//
// Known limitations (call out explicitly so future contributors don't
// "fix" them and break working flows):
//   - Attributes containing escaped quotes (\" inside a value) will
//     truncate at the first quote. The model rarely emits these.
//   - Nested tags of the same name are not handled; the outermost
//     closing tag wins. Matches LLM output patterns we observe.
const MAX_CLEAN_INPUT = 1_000_000; // 1 MB ceiling; well above any real message
export const cleanTraceabilityTags = (text: string) => {
    // (a) Reject non-string defensively. Earlier versions assumed a
    // string and would throw a TypeError on .replace() if a malformed
    // payload arrived (e.g. {chatToken: undefined}).
    if (typeof text !== 'string' || text.length === 0) { return ''; }

    // (c) Cap input. Slicing from the start preserves the leading
    // narrative which is what the user reads first; the cut-off tail
    // is rare and tolerable as a graceful failure mode.
    const input = text.length > MAX_CLEAN_INPUT
        ? text.slice(0, MAX_CLEAN_INPUT)
        : text;

    try {
        let cleaned = input;

        // 1. Format Models & APIs using standard Markdown Headers
        cleaned = cleaned.replace(/<model\s+id="([^"]+)">/gi, '\n### 🗄️ Model: `$1`\n\n');
        cleaned = cleaned.replace(/<\/model>/gi, '\n\n');

        cleaned = cleaned.replace(/<api\s+method="([^"]+)"\s+route="([^"]+)">/gi, '\n### 🔌 `$1` `$2`\n\n');
        cleaned = cleaned.replace(/<\/api>/gi, '\n\n');

        // 2. Consolidate Responses into clean, single-line bullets (No asterisks)
        cleaned = cleaned.replace(/<response>[\s\S]*?<code>([^<]+)<\/code>[\s\S]*?<description>([^<]+)<\/description>[\s\S]*?<\/response>/gi, '- 📤 Status `$1`: $2\n');

        // 3. Format Params & Fields as minimalist code elements
        cleaned = cleaned.replace(/<(field|param)\s+([^>]+)\/?>/gi, (_match, _tag, attrs) => {
            // Each attribute extraction guarded — a malformed attribute
            // shouldn't corrupt the whole field. On miss, fall back to
            // sensible defaults so the bullet still renders.
            const nameMatch = (typeof attrs === 'string' ? attrs.match(/name="([^"]+)"/i) : null);
            const typeMatch = (typeof attrs === 'string' ? attrs.match(/type="([^"]+)"/i) : null);
            const descMatch = (typeof attrs === 'string' ? attrs.match(/description="([^"]+)"/i) : null);
            const requiredMatch = (typeof attrs === 'string' ? attrs.match(/required="([^"]+)"/i) : null);

            const name = nameMatch ? nameMatch[1] : 'unknown';
            const type = typeMatch ? typeMatch[1] : '';
            const desc = descMatch ? descMatch[1] : '';

            let reqBadge = '';
            if (requiredMatch) {
                reqBadge = requiredMatch[1] === 'true' ? ' `Required`' : ' `Optional`';
            }

            const typeStr = type ? ` (${type})` : '';
            return `- \`${name}\`${typeStr}${reqBadge} — ${desc}\n`;
        });

        // 4. Use actual Markdown sub-headers (####) instead of bolding for sections
        cleaned = cleaned.replace(/<(request)>/gi, '\n#### Request Body\n\n');
        cleaned = cleaned.replace(/<(query)>/gi, '\n#### Query Parameters\n\n');
        cleaned = cleaned.replace(/<\/(request|query)>/gi, '\n\n');

        // 5. Format descriptions as standard blockquotes
        cleaned = cleaned.replace(/<description>([^<]+)<\/description>/gi, '\n> $1\n\n');

        // 6. Strip all REMAINING invisible structural matrix tags
        cleaned = cleaned.replace(/<\/?(epic|story|criteria|metadata|target_audience|nfr_list|architecture_components|data_models|api_routes|folder_structure|tasks|task|instructions)[^>]*>/gi, '');

        // 7. Enforce strict Markdown spacing (fixes ReactMarkdown choking on lists)
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

        return cleaned.trim();
    } catch (err) {
        // (b) Catch-all: degrade to the raw input rather than blanking
        // the chat panel. Webview logger surfaces the failure for
        // diagnosis without bothering the user.
        log.warn('cleanTraceabilityTags failed; returning raw text:', err);
        return input.trim();
    }
};

interface ProjectTask {
    step: string;
    file: string;
    detailedInstructions: string;
    relatedRequirement: string;
}

interface AIPlan {
    folderStructure: string[];
    implementationTasks: (string | ProjectTask)[];
}

interface Message {
    role: 'user' | 'assistant';
    content?: string;
    plan?: AIPlan;
    attachments?: AttachedContext[];
    isCompacted?: boolean;
}

interface AttachedContext { file: string; code: string; language: string; }
interface AtomicEdit { filepath: string; code: string; action: 'replace' | 'append' | 'inject'; target?: string; }
interface AgentStep { type: string; description: string; details?: string; }

/**
 * Icon registry. Wraps Lucide icons in <span> nodes so consumers can drop them
 * into JSX as plain values (matching the original ad-hoc-SVG API).
 *
 * Sizing rule: 14px is the body-text icon size. The Loader uses 12 to feel
 * lighter mid-sentence; Play uses 12 because it appears alongside small
 * button labels.
 *
 * Migration note (UI Tier 1, T2): this used to be 18 hand-rolled inline
 * SVGs. We swapped to Lucide because they're maintained, accessibility-
 * aware, and tree-shaken at build (only icons we import end up in the
 * bundle).
 */
const ICON_BASE = { size: 14, strokeWidth: 2 } as const;
const Icons = {
    // Original 18 — visual parity with the previous hand-rolled set
    User: <IconUser {...ICON_BASE} />,
    Nexus: <IconNexus {...ICON_BASE} />,
    Play: <IconPlay size={12} fill="currentColor" />,
    Check: <IconCheck {...ICON_BASE} />,
    UpArrow: <IconUpArrow size={14} strokeWidth={2.5} />,
    Brain: <IconBrain {...ICON_BASE} />,
    Loader: <IconLoader size={12} className="spin" />,
    Eye: <IconEye {...ICON_BASE} />,
    Plus: <IconPlus {...ICON_BASE} />,
    Trash: <IconTrash {...ICON_BASE} />,
    Search: <IconSearch {...ICON_BASE} />,
    Read: <IconRead {...ICON_BASE} />,
    Code: <IconCode {...ICON_BASE} />,
    Alert: <IconAlert {...ICON_BASE} />,
    Wrench: <IconWrench {...ICON_BASE} />,
    CheckCircle: <IconCheckCircle {...ICON_BASE} />,
    Build: <IconBuild {...ICON_BASE} />,
    Refresh: <IconRefresh {...ICON_BASE} />,
    // New for T2 — used at emoji replacement sites
    File: <IconFile {...ICON_BASE} />,
    Clipboard: <IconClipboard {...ICON_BASE} />,
    Link: <IconLink {...ICON_BASE} />,
    Warning: <IconWarning {...ICON_BASE} />,
    Wand: <IconWand {...ICON_BASE} />,
    Stop: <IconStop size={14} fill="currentColor" />,
    Restart: <IconRestart {...ICON_BASE} />,
    Sparkles: <IconSparkles {...ICON_BASE} />,
    Zap: <IconZap {...ICON_BASE} />,
    Save: <IconSave {...ICON_BASE} />,
    Flask: <IconFlask {...ICON_BASE} />,
    Archive: <IconArchive {...ICON_BASE} />,
    Edit: <IconEdit {...ICON_BASE} />,
    ExternalLink: <IconExternalLink size={12} />,
    XCircle: <IconXCircle {...ICON_BASE} />,
    Undo: <IconUndo {...ICON_BASE} />,
    FilePen: <IconFilePen {...ICON_BASE} />
};

export default function App() {
    const { t } = useTranslation();
    const chatTokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reasoningTokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    //  MAP & TRACEABILITY STATE
    const [graphPayload, setGraphPayload] = useState<any>(null);
    const [activeMapType, setActiveMapType] = useState<'codeMap' | 'reqMap' | 'combinedMap'>('combinedMap');
    const [isGraphLoading, setIsGraphLoading] = useState<boolean>(false);

    const [globalTokens, setGlobalTokens] = useState({ prompt: 0, completion: 0 });
    const [taskTokens, setTaskTokens] = useState<Record<string, { prompt: number, completion: number }>>({});

    const [taskSteps, setTaskSteps] = useState<Record<string, AgentStep[]>>({});
    // Component 2B-4a: tool-call cards state. Keyed by callId (every event
    // carries one). The reducer in toolEvents.ts handles created/updated
    // semantics. Cards are filtered + rendered by taskId matching.
    const [toolCallState, setToolCallState] = useState<Map<string, ToolCallState>>(new Map());
    // P1.4: hook fires state. Keyed by hookFireId. The reducer in
    // hookEvents.ts handles created/updated semantics. Cards render
    // inline in the chat thread, sorted by start time.
    const [hookFireState, setHookFireState] = useState<Map<string, HookFireState>>(new Map());
    // Per-task tool-card affinity (Phase 1): maps the backend's taskId
    // (the raw approach prompt sent into runTask) to the webview's
    // taskKey ("task-3" style). Populated by the `taskExecutionStarted`
    // message that fires before each runTask invocation. Used to filter
    // cards into per-task expansion regions instead of one global list.
    //
    // Why a separate map rather than walking taskKeys: backend taskIds
    // can be very long (whole approach prompts) and contain task-
    // descriptor text. A direct hash lookup is much cheaper than scanning
    // taskKeys for each event during render.
    const [taskBackendIdToKey, setTaskBackendIdToKey] = useState<Record<string, string>>({});
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<Message[]>([]);
    const [hasKey, setHasKey] = useState<boolean>(true);
    const [loading, setLoading] = useState(false);
    const [agentStatus, setAgentStatus] = useState<string>('');
    const [codingStyle, setCodingStyle] = useState('precise');
    const codingStyleRef = useRef('precise');
    const [taskStatuses, setTaskStatuses] = useState<Record<string, string>>({});
    const [taskSummaries, setTaskSummaries] = useState<Record<string, string>>({});
    const [taskFiles, setTaskFiles] = useState<Record<string, string>>({});
    const [taskReasoning, setTaskReasoning] = useState<Record<string, string>>({});
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [selectedModel, setSelectedModel] = useState<string>('');
    const [pendingEdits, setPendingEdits] = useState<AtomicEdit[] | null>(null);
    const [metaMode, setMetaMode] = useState(false);
    const [specTimer, setSpecTimer] = useState(0);

    const [attachedContexts, setAttachedContexts] = useState<AttachedContext[]>([]);
    const [builderContexts, setBuilderContexts] = useState<AttachedContext[]>([]);
    const searchTargetRef = useRef<'coder' | 'builder'>('coder');

    const [isLoaded, setIsLoaded] = useState(false);
    const [mentionQuery, setMentionQuery] = useState('');
    const [mentionResults, setMentionResults] = useState<string[]>([]);
    const [showMentionMenu, setShowMentionMenu] = useState(false);

    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<string[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    const chatEndRef = useRef<HTMLDivElement>(null);
    const sessionStoreRef = useRef<Record<string, { messages: Message[], taskSteps: Record<string, AgentStep[]>, taskReasoning: Record<string, string> }>>({});

    const currentStateRef = useRef({ messages, taskSteps, taskReasoning });
    useEffect(() => {
        currentStateRef.current = { messages, taskSteps, taskReasoning };
    }, [messages, taskSteps, taskReasoning]);

    const [activeTab, setActiveTab] = useState<'coder' | 'builder' | 'rules' | 'Map'>('coder');
    const [nexusRules, setNexusRules] = useState<string>('');
    const [requirements, setRequirements] = useState<string>('');
    // Phase-gate state (audit §11). null until first initState payload arrives.
    type PhaseStatus = 'not_started' | 'draft' | 'approved';
    interface PhaseState { requirements: PhaseStatus; design: PhaseStatus; tasks: PhaseStatus; updatedAt: string; }
    const [phaseState, setPhaseState] = useState<PhaseState | null>(null);
    const [rawIdea, setRawIdea] = useState<string>('');
    const [isGeneratingReqs, setIsGeneratingReqs] = useState(false);
    const [reqLogs, setReqLogs] = useState<string[]>([]);
    const [isEditingReqs, setIsEditingReqs] = useState(false);

    const [design, setDesign] = useState<string>('');
    const [isGeneratingDesign, setIsGeneratingDesign] = useState(false);
    const [isEditingDesign, setIsEditingDesign] = useState(false);
    const [isGeneratingTasks, setIsGeneratingTasks] = useState(false);

    const [activePlan, setActivePlan] = useState<AIPlan | null>(null);

    const [showGraph, setShowGraph] = useState(false);
    // Tightened type: nodes/edges are known properties (not index-signature
    // access), so noPropertyAccessFromIndexSignature is satisfied. The
    // remaining filename keys (e.g. "src/foo.ts") still go through the
    // index signature for older payload shapes.
    const [graphData, setGraphData] = useState<{ nodes?: any[]; edges?: any[]; [k: string]: any } | null>(null);
    // Graph granularity for the code-map view. 'file' shows
    // one node per file with edges = imports (architecture-level
    // overview). 'symbol' shows function and class nodes per file
    // (denser, useful for tracing call chains).
    //
    // Today, symbol-level data is derived from the existing FileNode
    // shape (`functions[]` / `classes[]`) — TS/JS only. v2.8 ships
    // cross-language Tree-sitter parsing + cross-file call edges +
    // semantic clustering, at which point symbol-level becomes the
    // primary view. The toggle UI is the same either way; only the
    // data fidelity behind it changes.
    const [graphGranularity, setGraphGranularity] = useState<'file' | 'symbol'>('file');
    // Right-side detail panel for the selected node. Single click on
    // a graph node populates this; double-click sends openFile to
    // the host. Null when nothing selected.
    const [selectedGraphNode, setSelectedGraphNode] = useState<{
        id: string;
        name: string;
        group: string | undefined;
        filepath?: string;
        symbol?: string;
    } | null>(null);

    const graphContainerRef = useRef<HTMLDivElement>(null);
    const [graphDims, setGraphDims] = useState({ width: 800, height: 600 });

    const [isAutopilot, setIsAutopilot] = useState(false);

    // ─── Execution mode (V2 phase) ─────────────────────────────────────
    //
    // Two ways to run a generated task list:
    //
    //   - 'plan'      User reviews each task; clicks Execute on each
    //                 individually. The default — matches v1's
    //                 interactive Kiro grade promise. Lowest blast
    //                 radius, ideal for compliance-sensitive customers.
    //
    //   - 'autonomy'  Once tasks are generated, the agent runs them
    //                 ALL sequentially without per-task clicks. Each
    //                 task still goes through the existing host-side
    //                 retry loop (max 2 attempts, then verifier
    //                 rejects). When Verifier rejects after retries,
    //                 the autonomy run STOPS — we don't continue past
    //                 a failed task because subsequent tasks usually
    //                 build on it and would just produce more broken
    //                 code on top.
    //
    // Future v2.6 governance: an admin portal will be able to lock
    // users into one mode. The state is intentionally a simple string
    // so an admin gate can override it without a state-shape change.
    const [executionMode, setExecutionMode] = useState<'plan' | 'autonomy'>('plan');

    // Autonomy run state. The queue is the ordered list of task keys
    // remaining to dispatch. The currently-executing task (the one
    // we're awaiting `taskCompleted` for) is NOT in the queue — it's
    // tracked via taskStatuses[key] === 'reviewing'. When taskCompleted
    // arrives with status 'approved', we shift the queue and dispatch
    // the next. With 'rejected'/'error' we clear the queue and surface
    // a banner.
    //
    // haltRef is a synchronous escape valve. The taskCompleted handler
    // runs AFTER React has scheduled a state update, so reading
    // autonomyQueue from state can race with a pending Halt click.
    // The ref gives the handler a definitive "should I dispatch the
    // next one?" answer regardless of render timing.
    const [autonomyQueue, setAutonomyQueue] = useState<string[]>([]);
    const [autonomyError, setAutonomyError] = useState<{ taskKey: string; message: string } | null>(null);
    const autonomyHaltRef = useRef<boolean>(false);

    // Thinking-mode state, mirrored from VS Code settings.
    // Default ON for all three matches the V2.0 setting defaults
    // (regulated-industry positioning prioritizes verification
    // accuracy over latency). Inline pill is a bulk toggle; per-
    // agent control is in VS Code settings (Cmd+,).
    const [thinkingMode, setThinkingMode] = useState<ThinkingModeFlags>({
        planner: true,
        coder: true,
        verifier: true,
    });

    // Mirror of the latest plan's per-task descriptors keyed by taskKey.
    // The autonomy loop dispatches tasks asynchronously after
    // `taskCompleted` events arrive — at that point it needs taskTitle
    // and prompt, but the per-task render closure (where they're
    // computed inline today) isn't available. We populate this ref
    // when the plan is rendered so the loop can look up by key.
    //
    // Why a ref not state: the lookup happens inside the message
    // handler, which would close over a stale state value. A ref
    // gives the handler the always-current snapshot. We don't render
    // off these values; we only read them inside event callbacks.
    const taskDescriptorsRef = useRef<Record<string, { taskTitle: string; prompt: string }>>({});

    const [sessions, setSessions] = useState<{ id: string, name: string }[]>([{ id: '1', name: 'New Session' }]);
    const [activeSessionId, setActiveSessionId] = useState('1');

    const [terminalStreams, setTerminalStreams] = useState<Record<string, string>>({});

    const [glassBrainContext, setGlassBrainContext] = useState<string>("");
    const [pendingCommand, setPendingCommand] = useState<{ command: string, message: string } | null>(null);

    // M-8: actionable banner when the security monitor itself is
    // unreachable (vs. when it declines a command). Rendered above the
    // chat input so it's always visible while the gate is offline.
    // null = banner hidden; object = banner visible with the last
    // reported reason. Cleared by user via Retry / Disable / Dismiss.
    const [securityBanner, setSecurityBanner] = useState<{
        command: string;
        reason: string;
    } | null>(null);
    // Whether the user has disabled the gate for this session. Mirrors
    // the host-side `_securityGateEnabled` toggle so the UI knows
    // whether the banner's "Disable for session" button has been used.
    const [securityGateDisabled, setSecurityGateDisabled] = useState(false);

    // P0: pending bash_exec command awaiting user approval. Set when
    // the host posts `requestBashApproval`; cleared when the user
    // clicks Allow / Block / Allow-always. While set, renders a
    // confirmation card above the chat input — the user must click
    // before the agent loop continues. Only one prompt can be
    // pending at a time (the agent loop is single-threaded today).
    const [pendingBashApproval, setPendingBashApproval] = useState<{
        command: string;
    } | null>(null);


    useEffect(() => {
        if (!showGraph || !graphContainerRef.current) { return; }

        const resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                setGraphDims({
                    width: entry.contentRect.width,
                    height: entry.contentRect.height
                });
            }
        });

        resizeObserver.observe(graphContainerRef.current);
        return () => resizeObserver.disconnect();
    }, [showGraph]);

    //  DYNAMIC GRAPH MAPPER
    // Gracefully handles both Old AST Dictionary and New Array [{nodes, edges}] formats
    const visualGraphData = useMemo(() => {
        if (!graphData) { return { nodes: [], links: [] }; }

        const nodes: any[] = [];
        const links: any[] = [];
        const nodeSet = new Set<string>();

        // FORMAT 1: New Tracability Map (Array Form)
        if (Array.isArray(graphData.nodes) && Array.isArray(graphData.edges)) {
            const validNodeIds = new Set<string>();

            graphData.nodes.forEach((n: any) => {
                let val = 5;
                const nodeGroup = (n.group || n.type || 'file').toLowerCase();

                if (nodeGroup === 'epic') { val = 8; }
                if (nodeGroup === 'story') { val = 6; }
                if (nodeGroup === 'criteria') { val = 4; }
                if (nodeGroup === 'task') { val = 7; }

                validNodeIds.add(n.id); // Register the node ID
                nodes.push({ id: n.id, name: n.label || n.id, group: nodeGroup, val });
            });

            graphData.edges.forEach((e: any) => {
                // 🔥 FIX 2: Safely extract string IDs from mutated WebGL objects
                const sourceId = typeof e.source === 'object' ? e.source.id : String(e.source || '');
                const targetId = typeof e.target === 'object' ? e.target.id : String(e.target || '');

                // 🔥 FIX 3: FIREWALL - Only push the link if BOTH nodes actually exist!
                if (validNodeIds.has(sourceId) && validNodeIds.has(targetId)) {
                    links.push({
                        source: sourceId,
                        target: targetId,
                        color: e.color ? e.color : (sourceId.includes('Epic') || sourceId.includes('Story') || sourceId.includes('EPIC') || sourceId.includes('STORY')) ? 'rgba(245, 66, 141, 0.8)' : 'rgba(51, 154, 240, 0.9)',
                        isSemantic: e.isSemantic,
                        weight: e.weight
                    });
                } else {
                    log.warn(`[Graph Firewall] Dropped hallucinated link: ${sourceId} -> ${targetId}`);
                }
            });

            return { nodes, links };
        }

        // FORMAT 2: Fallback for Pure AST Code Map (Dictionary Form)
        // Honors graphGranularity:
        //   - 'file':   one node per file, edges = file→file imports
        //   - 'symbol': file nodes + per-file functions + classes,
        //               edges = imports + parent-of (file→symbol)
        const isSymbolLevel = graphGranularity === 'symbol';
        Object.entries(graphData).forEach(([filepath, node]: [string, any]) => {
            if (filepath === 'nodes' || filepath === 'edges') return; // Guard clause

            // (folder variable removed in tsconfig hardening — was declared but never read.)
            const filename = filepath.split('/').pop() || '';

            nodes.push({ id: filepath, name: `📄 ${filename}`, group: 'file', val: 5 });
            nodeSet.add(filepath);

            if (isSymbolLevel) {
                node.functions?.forEach((func: string) => {
                    const funcId = `${filepath}::${func}`;
                    nodes.push({ id: funcId, name: `ƒ ${func}()`, group: 'function', val: 3 });
                    links.push({ source: filepath, target: funcId, color: 'rgba(51, 154, 240, 0.9)' });
                    nodeSet.add(funcId);
                });

                node.classes?.forEach((cls: string) => {
                    const clsId = `${filepath}::${cls}`;
                    nodes.push({ id: clsId, name: `© ${cls}`, group: 'class', val: 4 });
                    links.push({ source: filepath, target: clsId, color: 'rgba(252, 163, 17, 0.9)' });
                    nodeSet.add(clsId);
                });
            }

            node.imports?.forEach((imp: string) => {
                const cleanImp = imp.replace(/['"]/g, '');
                let targetFile = Object.keys(graphData).find(k => k.includes(cleanImp.replace('./', '').replace('../', '')));
                if (targetFile) {
                    links.push({ source: filepath, target: targetFile, color: 'rgba(245, 66, 141, 0.8)' });
                }
            });
        });

        return { nodes, links };
    }, [graphData, graphGranularity]);

    useEffect(() => { codingStyleRef.current = codingStyle; }, [codingStyle]);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, terminalStreams, glassBrainContext, pendingCommand]);

    useEffect(() => {
        vscode.postMessage({ type: 'webviewReady' });
        vscode.postMessage({ type: 'requestModels' });
    }, []);

    useEffect(() => {
        let interval: ReturnType<typeof setTimeout>;
        if (isGeneratingReqs || isGeneratingDesign || isGeneratingTasks) {
            interval = setInterval(() => setSpecTimer(t => t + 1), 1000);
        } else {
            setSpecTimer(0);
        }
        return () => clearInterval(interval);
    }, [isGeneratingReqs, isGeneratingDesign, isGeneratingTasks]);

    const formatTime = (sec: number) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    useEffect(() => {
        if (graphPayload) {
            setGraphData(graphPayload[activeMapType] || null);
        }
    }, [activeMapType, graphPayload]);

    useEffect(() => {
        const messageHandler = (event: MessageEvent) => {
            // M-6: validate inbound host→webview messages against the
            // shared protocol. parseHostMessage returns null (and logs)
            // for unknown types, which catches drift between the host
            // and webview when a message is renamed on one side but
            // not the other. Per-branch logic below stays unchanged.
            const data = parseHostMessage(event.data);
            if (!data) { return; }

            if (data.type === 'tokenUsage') {
                // Accumulate Global Tokens
                setGlobalTokens(prev => ({
                    prompt: prev.prompt + (data.usage.prompt_tokens || 0),
                    completion: prev.completion + (data.usage.completion_tokens || 0)
                }));
                // Accumulate Task Tokens
                if (data.task) {
                    setTaskTokens(prev => {
                        const current = prev[data.task] || { prompt: 0, completion: 0 };
                        return {
                            ...prev,
                            [data.task]: {
                                prompt: current.prompt + (data.usage.prompt_tokens || 0),
                                completion: current.completion + (data.usage.completion_tokens || 0)
                            }
                        };
                    });
                }
            }

            if (data.type === 'historyCompacted') {
                setMessages(data.messages);
            }

            if (data.type === 'clearTerminalStream') {
                setTerminalStreams(prev => {
                    const next = { ...prev };
                    delete next[data.task];
                    return next;
                });
            }

            if (data.type === 'streamTerminal') {
                setTerminalStreams(prev => ({
                    ...prev,
                    [data.task]: (prev[data.task] || '') + data.text
                }));
            }

            if (data.type === 'tasksGenerated') {
                setIsGeneratingTasks(false);
                setActiveTab('coder');
            }

            // M-8: security monitor itself failed (vs. declining a command).
            // Surface as an actionable banner. Replacing any prior banner
            // is intentional — the latest failure carries the most useful
            // reason; we don't queue them.
            if (data.type === 'securityMonitorUnavailable') {
                setSecurityBanner({
                    command: typeof data.command === 'string' ? data.command : '',
                    reason: typeof data.reason === 'string' ? data.reason : 'Security Monitor unavailable.'
                });
            }

            // P0: bash_exec command awaiting user approval. Replaces any
            // prior pending approval (only one can be active at a time
            // because the agent loop is single-threaded). Stays visible
            // until the user clicks Allow / Block / Allow-always.
            if (data.type === 'requestBashApproval') {
                setPendingBashApproval({
                    command: typeof data.command === 'string' ? data.command : ''
                });
            }

            //  TRACEABILITY PAYLOAD CAPTURE

            if (data.type === 'workspaceGraphData') {
                log.debug("[DEBUG-MAP-UI] Received workspaceGraphData from backend!", data);
            }

            if (data.type === 'workspaceGraphData') {
                try {
                    const parsedPayload = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
                    log.debug("[DEBUG-MAP-UI] Successfully parsed payload:", parsedPayload);
                    setGraphPayload(parsedPayload);
                    setGraphData(parsedPayload.combinedMap || { nodes: [], edges: [] });
                    if (parsedPayload.isGraphLoading) {
                        // Force the UI to show the CodeMap while the others load
                        setActiveMapType('codeMap');
                        setGraphData(parsedPayload.codeMap || { nodes: [], edges: [] });
                        setShowGraph(true);
                    } else {
                        // When finished, default back to Combined Map
                        setActiveMapType('combinedMap');
                        setGraphData(parsedPayload.combinedMap || { nodes: [], edges: [] });
                    }
                } catch (err) {
                    log.error("[DEBUG-MAP-UI] Failed to parse incoming graph payload:", err);
                }
            }

            if (data.type === 'startRevision') {
                const { task, feedback } = data;
                setTaskStatuses(prev => ({ ...prev, [task]: 'reviewing' }));
                setTaskSummaries(prev => ({ ...prev, [task]: 'Revising based on feedback...' }));
                setTaskSteps(prev => ({ ...prev, [task]: [] }));
                setTaskReasoning(prev => ({ ...prev, [task]: '' }));
                vscode.postMessage({ type: 'executeTask', task: task, codingStyle: codingStyleRef.current, feedback: feedback });
            }

            if (data.type === 'injectTerminalTask') {
                const terminalTask = data.task;
                setMessages(prev => [...prev,
                { role: 'user', content: terminalTask },
                { role: 'assistant', content: "I am analyzing your terminal crash right now. Hang tight..." }
                ]);
                setTaskStatuses(prev => ({ ...prev, [terminalTask]: 'reviewing' }));
                vscode.postMessage({ type: 'executeTask', task: terminalTask, codingStyle: codingStyleRef.current });
            }

            if (data.type === 'agentStep') {
                setTaskSteps(prev => {
                    const currentSteps = prev[data.task] || [];
                    const lastStep = currentSteps[currentSteps.length - 1];

                    // 🚀 THE UI FIX: Bundle consecutive identical steps together!
                    if (lastStep && lastStep.description === data.description && lastStep.type === data.stepType) {
                        const newSteps = [...currentSteps];
                        newSteps[newSteps.length - 1] = {
                            ...lastStep,
                            // Concat the tool executions with a clean newline
                            details: lastStep.details ? `${lastStep.details}\n${data.details}` : data.details
                        };
                        return { ...prev, [data.task]: newSteps };
                    }

                    // Otherwise, append as a brand new step card
                    return {
                        ...prev,
                        [data.task]: [...currentSteps, { type: data.stepType, description: data.description, details: data.details }]
                    };
                });
            }

            // Component 2B-4: tool-call lifecycle events from the
            // Coordinator's ReAct loop (and eventually planAgent +
            // verificationAgent). Each event mutates per-callId state
            // via applyToolEvent. Cards render from this state.
            //
            // Forward-compat: applyToolEvent silently ignores unknown
            // event types, so newer events don't crash an older bundle.
            if (data.type === 'toolCallEvent') {
                setToolCallState(prev => applyToolEvent(prev, data.event as ToolLifecycleEvent));
            }

            // P1.4: hook lifecycle events from HookManager. Same shape
            // as toolCallEvent but a separate state map and reducer
            // because hooks have different semantics (no taskId, no
            // arguments, no LLM-visible result).
            if (data.type === 'hookEvent') {
                setHookFireState(prev => applyHookEvent(prev, data.event as HookLifecycleEvent));
            }

            // Per-task affinity: when SidebarProvider kicks off runTask,
            // it sends this message so the webview learns the backend's
            // taskId (the raw approach prompt) and can map it to the
            // webview's taskKey for grouping incoming card events.
            if (data.type === 'taskExecutionStarted') {
                const { taskKey, backendTaskId } = data as { taskKey: string; backendTaskId: string };
                if (typeof taskKey === 'string' && typeof backendTaskId === 'string') {
                    setTaskBackendIdToKey(prev => {
                        // Idempotent: re-execution of the same task uses
                        // the same mapping.
                        if (prev[backendTaskId] === taskKey) { return prev; }
                        return { ...prev, [backendTaskId]: taskKey };
                    });
                }
            }

            if (data.type === 'searchResults') {
                const lineMatch = data.originalQuery?.match(/:\d+(?:-\d+)?$/);
                const suffix = lineMatch ? lineMatch[0] : '';
                const updatedResults = data.results.map((r: string) => r + suffix);

                setMentionResults(updatedResults);
                setSearchResults(updatedResults);
            }

            if (data.type === 'addContext') {
                if (searchTargetRef.current === 'coder') {
                    setAttachedContexts(prev => {
                        if (prev.some(c => c.file === data.file && c.code === data.code)) { return prev; }
                        return [...prev, { file: data.file, code: data.code, language: data.language }];
                    });
                    setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
                } else {
                    setBuilderContexts(prev => {
                        if (prev.some(c => c.file === data.file && c.code === data.code)) { return prev; }
                        return [...prev, { file: data.file, code: data.code, language: data.language }];
                    });
                }
                setSearchQuery('');
                setSearchResults([]);
                setIsSearching(false);
                setMentionQuery('');
                setMentionResults([]);
                setShowMentionMenu(false);
            }

            if (data.type === 'insertText') {
                setInput(prev => prev + (prev.length > 0 && !prev.endsWith('\n') ? '\n' : '') + data.text);
                setTimeout(() => {
                    const el = document.getElementById('chat-input');
                    if (el) { el.focus(); el.scrollTop = el.scrollHeight; }
                }, 100);
            }

            if (data.type === 'addUserMessageAndSubmit') {
                const displayContent = `${data.text}\n\n*(Attached from Editor)*\n${data.context || ''}`;
                setMessages(prev => [...prev, { role: 'user', content: displayContent }]);
                setLoading(true);
                vscode.postMessage({
                    type: 'processUserMessage',
                    text: data.text,
                    context: data.context,
                    codingStyle: codingStyleRef.current,
                    autopilot: isAutopilot
                });
            }

            if (data.type === 'initState') {
                const loadedMsgs = data.messages || [];
                setHasKey(data.hasKey);
                if (data.taskStatuses) { setTaskStatuses(data.taskStatuses); }
                if (data.taskSummaries) { setTaskSummaries(data.taskSummaries); }
                if (data.taskFiles) { setTaskFiles(data.taskFiles); }
                if (data.requirements) { setRequirements(data.requirements); }
                if (data.design) { setDesign(data.design); }
                if (data.nexusRules) { setNexusRules(data.nexusRules); }
                if (data.phaseState) { setPhaseState(data.phaseState); }

                // V2.0 follow-up: inline thinking-mode toggle. The
                // host reads VS Code settings on webviewReady and
                // sends them here. If the host is older (no
                // thinkingMode key in payload), we keep the default
                // (all-on) and the inline pill stays in "🧠 ON" state.
                if (data.thinkingMode &&
                    typeof data.thinkingMode.planner === 'boolean' &&
                    typeof data.thinkingMode.coder === 'boolean' &&
                    typeof data.thinkingMode.verifier === 'boolean'
                ) {
                    setThinkingMode({
                        planner:  data.thinkingMode.planner,
                        coder:    data.thinkingMode.coder,
                        verifier: data.thinkingMode.verifier,
                    });
                }

                if (data.tasks) {
                    setActivePlan(data.tasks);
                    const hasPlan = loadedMsgs.some((m: Message) => m.plan);
                    if (!hasPlan) {
                        setMessages([...loadedMsgs, {
                            role: 'assistant',
                            content: "Welcome back! Here is your active implementation plan. You can execute tasks autonomously, or code them yourself and ask me to verify them.",
                            plan: data.tasks
                        }]);
                    } else {
                        setMessages(loadedMsgs);
                    }
                } else {
                    setMessages(loadedMsgs);
                }

                setTimeout(() => setIsLoaded(true), 100);
            }

            if (data.type === 'requestCommandApproval') {
                setPendingCommand({
                    command: data.command,
                    message: data.message
                });
            }

            if (data.type === 'requirementsUpdated' || data.type === 'requirementsGenerated') {
                setRequirements(data.text);
                if (data.type === 'requirementsGenerated') { setIsGeneratingReqs(false); }
            }

            if (data.type === 'designGenerated') {
                setDesign(data.text);
                setIsGeneratingDesign(false);
            }

            if (data.type === 'phaseStateUpdated') {
                setPhaseState(data.phaseState);
            }

            if (data.type === 'reqStep') {
                setReqLogs(prev => [...prev, data.message]);
            }

            if (data.type === 'generationFailed') {
                setIsGeneratingReqs(false);
                setIsGeneratingDesign(false);
                setIsGeneratingTasks(false);
            }

            if (data.type === 'updateModelsList') {
                setAvailableModels(data.models);
                if (data.currentModel && data.models.includes(data.currentModel)) { setSelectedModel(data.currentModel); }
                else if (data.models.length > 0) setSelectedModel(data.models[0]);
            }

            if (data.type === 'structureResponse') {
                setActivePlan(data.value);
                setMessages(prev => [...prev, { role: 'assistant', plan: data.value }]);
                setLoading(false);
                setIsGeneratingTasks(false);
                setActiveTab('coder');
            }

            if (data.type === 'statusUpdate') { setAgentStatus(data.message); }
            if (data.type === 'reviewEdits') { setPendingEdits(data.edits); setLoading(false); }
            if (data.type === 'allTasksCompleted') {
                setPendingEdits(null);
                setMessages(prev => [...prev, { role: 'assistant', content: "✅ Atomic transaction committed successfully." }]);
                setAgentStatus('');
            }
            if (data.type === 'taskCompleted' || data.type === 'taskStatusUpdate') {
                setTaskStatuses(prev => ({ ...prev, [data.task]: data.status }));
                if (data.summary) { setTaskSummaries(prev => ({ ...prev, [data.task]: data.summary })); }
                if (data.filepath) { setTaskFiles(prev => ({ ...prev, [data.task]: data.filepath })); }
                if (data.status === 'error') { setLoading(false); }
            }

            // Autonomy mode: advance the queue when a task reaches a
            // terminal state. Only listens for `taskCompleted` (final),
            // not `taskStatusUpdate` (intermediate). The host has
            // already exhausted its 2-attempt retry by the time we get
            // here, so the status is what we have to act on.
            //
            // The decision logic lives in advanceAutonomyQueue (pure
            // module under unit test); this handler just wires it up
            // to setState and dispatch.
            if (data.type === 'taskCompleted') {
                setAutonomyQueue(prevQueue => {
                    const status = data.status as 'approved' | 'rejected' | 'error';
                    const decision = advanceAutonomyQueue({
                        prevQueue,
                        completedTask: data.task,
                        status,
                        haltRequested: autonomyHaltRef.current,
                    });

                    if (decision.action === 'ignore') {
                        return prevQueue;
                    }
                    if (decision.action === 'finish') {
                        // Queue empty; allTasksCompleted banner fires
                        // separately from the host's plan-completion
                        // path, so nothing to do here.
                        return decision.nextQueue;
                    }
                    if (decision.action === 'halt') {
                        setAutonomyError({
                            taskKey: decision.failedTask,
                            message: decision.reason === 'rejected'
                                ? 'Task was rejected after retries. Autonomy run stopped — fix this task, then resume.'
                                : 'Task failed with an error. Autonomy run stopped — see the task panel for details.',
                        });
                        return [];
                    }
                    // decision.action === 'advance'
                    const nextKey = decision.nextTaskKey;
                    const desc = taskDescriptorsRef.current[nextKey];
                    if (!desc) {
                        // Descriptor missing — should never happen
                        // because we populate it in startAutonomyRun.
                        // Bail out cleanly with an error banner.
                        setAutonomyError({
                            taskKey: nextKey,
                            message: 'Internal error: task descriptor missing for next task. Run halted.',
                        });
                        return [];
                    }
                    // Defer the dispatch one tick — React is mid-
                    // setState and we don't want our setTaskStatuses
                    // call inside dispatchTaskExecution to land in
                    // the same batch as the current update.
                    setTimeout(() => {
                        if (autonomyHaltRef.current) { return; }
                        dispatchTaskExecution(nextKey, desc.taskTitle, desc.prompt);
                    }, 0);
                    return decision.nextQueue;
                });
            }

            if (data.type === 'streamReasoning') {
                reasoningTokenBuffer += data.token;
                if (!reasoningTokenTimerRef.current) {
                    reasoningTokenTimerRef.current = setTimeout(() => {
                        const flush = reasoningTokenBuffer;
                        reasoningTokenBuffer = "";
                        reasoningTokenTimerRef.current = null;
                        setTaskReasoning(prev => ({
                            ...prev, [data.task]: (prev[data.task] || '') + flush
                        }));
                    }, 50);
                }
            }

            if (data.type === 'glassBrain') {
                setGlassBrainContext(data.text);
            }

            if (data.type === 'startChatStream') {
                setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
                setLoading(false);
                setGlassBrainContext("");
            }

            if (data.type === 'chatToken') {
                chatTokenBuffer += data.token;
                if (!chatTokenTimerRef.current) {
                    chatTokenTimerRef.current = setTimeout(() => {
                        const flush = chatTokenBuffer;
                        chatTokenBuffer = "";
                        chatTokenTimerRef.current = null;
                        setMessages(prev => {
                            const newMessages = [...prev];
                            const lastIdx = newMessages.length - 1;
                            if (newMessages[lastIdx] && newMessages[lastIdx].role === 'assistant') {
                                newMessages[lastIdx].content = (newMessages[lastIdx].content || "") + flush;
                            }
                            return newMessages;
                        });
                    }, 50);
                }
            }

            if (data.type === 'metaModeChanged') { setMetaMode(data.value); }
            if (data.type === 'thinkingModeChanged' &&
                data.mode &&
                typeof data.mode.planner === 'boolean' &&
                typeof data.mode.coder === 'boolean' &&
                typeof data.mode.verifier === 'boolean'
            ) {
                setThinkingMode({
                    planner:  data.mode.planner,
                    coder:    data.mode.coder,
                    verifier: data.mode.verifier,
                });
            }
            if (data.type === 'requestReview') { setInput(`Please review this code:\n\n\`\`\`\n${data.code}\n\`\`\``); }
        };
        window.addEventListener('message', messageHandler);
        return () => window.removeEventListener('message', messageHandler);
    }, [isAutopilot]); // Dependency included

    useEffect(() => {
        if (hasKey && isLoaded) {
            vscode.postMessage({
                type: 'syncHistory',
                messages: messages,
                taskStatuses: taskStatuses,
                taskSummaries: taskSummaries,
                taskFiles: taskFiles
            });
        }
    }, [messages, taskStatuses, taskSummaries, taskFiles, hasKey, isLoaded]);

    // ─── Task execution dispatch ────────────────────────────────────────
    //
    // Single helper used by BOTH the per-task Execute button and the
    // autonomy-mode loop. Resets the per-task UI state to "running"
    // and posts the executeTask message to the host. The host runs
    // its existing retry loop (max 2 attempts, then verifier rejects)
    // and emits taskCompleted when done — the autonomy loop listens
    // for that event to dispatch the next queued task.
    //
    // taskTitleForBackend / prompt come from the per-task render
    // closure when called by the inline button, OR from the
    // taskDescriptorsRef snapshot when called by the autonomy loop.
    // Either source produces identical wire shape.
    const dispatchTaskExecution = React.useCallback((
        taskKey: string,
        taskTitleForBackend: string,
        prompt: string
    ) => {
        setTaskStatuses(prev => ({ ...prev, [taskKey]: 'reviewing' }));
        setTaskSteps(prev => ({ ...prev, [taskKey]: [] }));
        setTaskReasoning(prev => ({ ...prev, [taskKey]: '' }));
        vscode.postMessage({
            type: 'executeTask',
            task: taskKey,
            taskTitle: taskTitleForBackend,
            prompt,
            codingStyle: codingStyleRef.current,
        });
    }, []);

    // Start (or restart) the autonomy run from the latest plan.
    // Walks the plan's tasks in order, builds the queue of pending
    // taskKeys, dispatches the first one. Subsequent ones are
    // dispatched by the taskCompleted handler.
    //
    // If the user starts an autonomy run mid-way (some tasks already
    // completed), we skip already-approved tasks. A user might do
    // this if they ran tasks 1-3 in plan mode then want autonomy for
    // the rest.
    const startAutonomyRun = React.useCallback(() => {
        // Find the latest plan-bearing message
        const planMsg = [...messages].reverse().find(m => m.plan?.implementationTasks?.length);
        if (!planMsg?.plan) { return; }

        // Build the descriptor snapshot for ALL tasks (we need them
        // even for 'approved' tasks because the user might re-run
        // them later from the plan-mode buttons). Then build the
        // queue with `buildInitialAutonomyQueue`, which skips
        // already-approved tasks (resume-from-mid-list semantics).
        const allKeys: string[] = [];
        const descriptors: Record<string, { taskTitle: string; prompt: string }> = {};
        planMsg.plan.implementationTasks.forEach((rawTask, tIdx) => {
            const isObj = typeof rawTask !== 'string';
            const taskObj = isObj ? (rawTask as ProjectTask) : null;
            const taskKey = taskObj ? `task-${tIdx}` : (rawTask as string);
            const taskTitle = taskObj ? taskObj.step : (rawTask as string);
            const taskReq = taskObj ? taskObj.relatedRequirement : '';
            const prompt = taskObj
                ? `Task: ${taskObj.step}\nTarget File: ${taskObj.file}\nRelated PRD Requirement: ${taskReq}\n\nDetailed Instructions: ${taskObj.detailedInstructions}`
                : (rawTask as string);
            descriptors[taskKey] = { taskTitle, prompt };
            allKeys.push(taskKey);
        });

        const queue = buildInitialAutonomyQueue(allKeys, taskStatuses);

        if (queue.length === 0) {
            // Nothing to do — all tasks already approved.
            setAutonomyError(null);
            return;
        }

        taskDescriptorsRef.current = descriptors;
        autonomyHaltRef.current = false;
        setAutonomyError(null);
        setAutonomyQueue(queue);

        // Dispatch the first task. Subsequent ones flow from the
        // taskCompleted handler in the message useEffect.
        const firstKey = queue[0]!;
        const desc = descriptors[firstKey]!;
        dispatchTaskExecution(firstKey, desc.taskTitle, desc.prompt);
    }, [messages, taskStatuses, dispatchTaskExecution]);

    const haltAutonomyRun = React.useCallback(() => {
        autonomyHaltRef.current = true;
        setAutonomyQueue([]);
        // Note: we don't abort the currently-executing task. The user
        // can do that with the existing per-task abort path. This
        // halt only stops dispatching SUBSEQUENT tasks.
    }, []);

    // ─── Per-task tool-card grouping (Phase 1 affinity) ──────────────
    //
    // CRITICAL: this useMemo MUST live before the early returns below
    // (`if (!isLoaded) return ...`, `if (!hasKey) return ...`). React's
    // Rules of Hooks require all hooks to be called in the same order
    // every render — placing this useMemo after the early returns would
    // cause it to be skipped on first render (when isLoaded=false) and
    // called on subsequent renders, triggering React error #310 and a
    // blank screen. The Phase 1 hotfix corrected this placement.
    //
    // resolveTaskKey is a plain helper (no hooks of its own), but it's
    // declared here so it stays adjacent to its sole consumer below.
    const resolveTaskKey = (backendTaskId: string): string | null => {
        const baseTaskId = backendTaskId.split('::')[0] ?? backendTaskId;
        return taskBackendIdToKey[baseTaskId] ?? null;
    };

    const cardsByTaskKey = useMemo(() => {
        const groups: Record<string, ToolCallState[]> = {};
        const unscoped: ToolCallState[] = [];
        for (const card of toolCallState.values()) {
            const key = resolveTaskKey(card.taskId);
            if (key === null) {
                unscoped.push(card);
            } else {
                if (!groups[key]) { groups[key] = []; }
                groups[key]!.push(card);
            }
        }
        // Sort each group's cards by start order (deterministic render).
        for (const key of Object.keys(groups)) {
            groups[key]!.sort((a, b) => a.startSeq - b.startSeq);
        }
        unscoped.sort((a, b) => a.startSeq - b.startSeq);
        return { groups, unscoped };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [toolCallState, taskBackendIdToKey]);

    // ─────────────────────────────────────────────────────────────────
    // CRITICAL: All hooks MUST be declared above the early-return
    // guards below (`if (!isLoaded) return ...`, `if (!hasKey) return ...`).
    // If a hook is placed AFTER an early return, it gets skipped on the
    // first render (when isLoaded=false) and called on subsequent
    // renders — a Rules of Hooks violation that crashes the webview
    // (React error #310: "Rendered fewer hooks than expected").
    // ─────────────────────────────────────────────────────────────────

    // PR 2.4: panel state + audit log subscription. Both are
    // self-contained hooks; the panel state is purely UI, the audit
    // log subscribes to host messages via useEffect.
    const panel = usePanel();
    const audit = useAuditLog();

    // PR 3.1: ref for the requirements textarea so the EARS helper
    // can insert keywords at the cursor position.
    const requirementsTextareaRef = useRef<HTMLTextAreaElement>(null);

    // PR 3.2: hooks state. useHooks subscribes to hookListUpdated
    // host messages and exposes toggleHook/runHook commands.
    const hooks = useHooks(vscode);

    // PR 3.3: steering state. Same shape as useHooks.
    const steering = useSteering(vscode);

    // P2.1: MCP servers state. Same shape — subscribes to host
    // mcpStatusUpdated messages, exposes a reload action.
    const mcp = useMcp(vscode);

    // P3.1 panel: diagnostics state. Subscribes to sessionListUpdated,
    // sessionBundleUpdated, startupTimingUpdated host messages.
    const diagnostics = useDiagnostics(vscode);

    if (!isLoaded) { return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--nexus-subtext)' }}>{t("chat.loading_nexus")}</div>; }

    if (!hasKey) {
        return (
            <div className="auth-screen">
                <div className="auth-screen-card">
                    <span className="auth-screen-brand">{Icons.Nexus} NexusCode</span>
                    <h2 className="auth-screen-title">{t("onboarding.welcome_andromeda")}</h2>
                    <p className="auth-screen-subtitle">{t("onboarding.save_key_prompt")}</p>
                    <input
                        className="auth-screen-input"
                        type="password"
                        id="api-key-input"
                        placeholder="sk-proj-..."
                        autoFocus
                    />
                    <button
                        className="nexus-btn-primary nexus-btn--equal"
                        onClick={() => {
                            const val = (document.getElementById('api-key-input') as HTMLInputElement).value;
                            if (val) { vscode.postMessage({ type: 'saveApiKey', value: val }); }
                        }}
                    >
                        {t("onboarding.save_key_button")}
                    </button>
                    <div className="auth-screen-divider" />
                    <button
                        className="nexus-btn-ghost"
                        style={{ alignSelf: 'center' }}
                        onClick={() => {
                            vscode.postMessage({ type: 'saveApiKey', value: 'lm-studio' });
                        }}
                    >
                        {t("onboarding.skip_local_button")}
                    </button>
                </div>
            </div>
        );
    }

    const handleSubmit = (overrideText?: string) => {
        const text = overrideText || input;
        if ((!text.trim() && attachedContexts.length === 0) || loading) return;

        let finalQuery = text.trim() || "Please review the attached code.";
        let contextStr = "";

        if (attachedContexts.length > 0) {
            contextStr = attachedContexts.map(c => `\n\`\`\`${c.language} title="${c.file}"\n${c.code}\n\`\`\`\n`).join('');
        }

        setMessages(prev => [...prev, { role: 'user', content: finalQuery, attachments: attachedContexts }]);
        setLoading(true);

        vscode.postMessage({
            type: 'processUserMessage',
            text: finalQuery,
            context: contextStr,
            codingStyle: codingStyleRef.current,
            autopilot: isAutopilot,
            history: messages
        });

        setInput('');
        setAttachedContexts([]);
        const textarea = document.getElementById('chat-input');
        if (textarea) { textarea.style.height = 'auto'; }
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const val = e.target.value;
        setInput(val);
        e.target.style.height = 'auto';
        e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;

        const cursorPosition = e.target.selectionStart;
        const textBeforeCursor = val.substring(0, cursorPosition);
        const words = textBeforeCursor.split(/\s/);
        const lastWord = words[words.length - 1] ?? '';

        if (lastWord.startsWith('@')) {
            setShowMentionMenu(true);
            const query = lastWord.substring(1);
            setMentionQuery(query);
            vscode.postMessage({ type: 'searchFiles', query });
        } else {
            setShowMentionMenu(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
    };

    const handleClearHistory = () => {
        vscode.postMessage({ type: 'clearHistory' });

        if (activePlan) {
            setMessages([{ role: 'assistant', content: "Conversation cleared. Active Implementation Plan preserved:", plan: activePlan }]);
        } else {
            setMessages([]);
        }

        setTaskSteps({});
        setTaskReasoning({});
        setTaskStatuses({});
        setTaskSummaries({});
        setTaskFiles({});

        sessionStoreRef.current = {};
        setSessions([{ id: '1', name: 'New Session' }]);
        setActiveSessionId('1');
    };

    const switchSession = (newId: string) => {
        if (newId === activeSessionId) { return; }

        sessionStoreRef.current[activeSessionId] = currentStateRef.current;

        const nextState = sessionStoreRef.current[newId] || {
            messages: activePlan ? [{ role: 'assistant', content: "New session started. Active Implementation Plan preserved:", plan: activePlan }] : [],
            taskSteps: {},
            taskReasoning: {}
        };

        setMessages(nextState.messages);
        setTaskSteps(nextState.taskSteps);
        setTaskReasoning(nextState.taskReasoning);
        setActiveSessionId(newId);
    };

    return (
        <AppShell
            rail={
                <Rail
                    auditPanelOpen={panel.isOpen && panel.kind === 'audit'}
                    onAuditClick={() => panel.toggle('audit')}
                    hooksPanelOpen={panel.isOpen && panel.kind === 'hooks'}
                    onHooksClick={() => panel.toggle('hooks')}
                    steeringPanelOpen={panel.isOpen && panel.kind === 'steering'}
                    onSteeringClick={() => panel.toggle('steering')}
                    mcpPanelOpen={panel.isOpen && panel.kind === 'mcp'}
                    onMcpClick={() => panel.toggle('mcp')}
                    diagnosticsPanelOpen={panel.isOpen && panel.kind === 'diagnostics'}
                    onDiagnosticsClick={() => panel.toggle('diagnostics')}
                    activeRoute={activeTab}
                    onRouteChange={(route) => {
                        setActiveTab(route);
                        // Map view: preserve the existing fetch-on-first-open
                        // behavior. PR 2.x will move this side-effect into a
                        // useViewRoute hook.
                        if (route === 'Map' && !graphPayload) {
                            vscode.postMessage({ type: 'requestWorkspaceGraph' });
                        }
                    }}
                    onSettingsClick={() => {
                        // Existing flow: open the VS Code settings UI scoped
                        // to NexusCode config. The host listens for this
                        // message and runs `workbench.action.openSettings`.
                        vscode.postMessage({ type: 'openSettings' });
                    }}
                />
            }
            securityStrip={
                <SecurityStrip
                    status={{
                        // PR 1.3: derived from the audit-fix state already
                        // present in App.tsx. PR 2.x will lift this into a
                        // useSecurityStatus hook when App.tsx is decomposed.
                        denylistActive: true,
                        // Monitor is online unless we got a
                        // securityMonitorUnavailable message AND the user
                        // hasn't dismissed/disabled it.
                        monitorOnline: !securityBanner,
                        // Confirm-on-bash flips off when the user disables
                        // the gate for the session via the banner action.
                        confirmOnBash: !securityGateDisabled,
                        // Pre-empts confirmOnBash when a bash command is
                        // currently waiting on user click.
                        awaitingApproval: pendingBashApproval !== null,
                        // PR 2.4: live from useAuditLog. The chain
                        // starts valid (no records = nothing to break) and
                        // flips to false on the first malformed record.
                        auditChainValid: audit.chainValid,
                    } satisfies SecurityStatus}
                />
            }
            panel={
                panel.isOpen && panel.kind === 'audit' ? (
                    <AuditLogPanel
                        audit={audit}
                        onClose={panel.close}
                    />
                ) : panel.isOpen && panel.kind === 'hooks' ? (
                    <HooksPanel
                        hooks={hooks}
                        onClose={panel.close}
                        onOpenHook={(id) => vscode.postMessage({ type: 'openHookFile', id })}
                    />
                ) : panel.isOpen && panel.kind === 'steering' ? (
                    <SteeringPanel
                        steering={steering}
                        onClose={panel.close}
                    />
                ) : panel.isOpen && panel.kind === 'mcp' ? (
                    <McpPanel
                        mcp={mcp}
                        onClose={panel.close}
                    />
                ) : panel.isOpen && panel.kind === 'diagnostics' ? (
                    <DiagnosticsPanel
                        diagnostics={diagnostics}
                        onClose={panel.close}
                    />
                ) : undefined
            }
        >
            {/* Meta-mode indicator. Was previously rendered in the brand
                header; the brand is now the rail logo, so meta-mode shows
                here as a thin warning bar above the canvas. */}
            {metaMode && (
                <div className="nexus-meta-mode-banner" role="status">
                    {Icons.Warning}
                    <span>SELF-EVOLUTION ACTIVE</span>
                </div>
            )}

            {/* ========================================================= */}
            {/* 💻 TAB 1: THE CODER (Chat & Execution)                      */}
            {/* ========================================================= */}
            <div style={{ display: activeTab === 'coder' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                <div className="nexus-session-tabs">
                    {sessions.map(s => (
                        <div
                            key={s.id}
                            className={`nexus-session-tab${s.id === activeSessionId ? ' active' : ''}`}
                            onClick={() => switchSession(s.id)}
                        >
                            <span className="nexus-session-tab-name">
                                <span className="nexus-session-tab-dot" aria-hidden="true"></span>
                                {s.name}
                            </span>
                            <button
                                className="nexus-session-tab-close"
                                aria-label="Close session"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (sessions.length > 1) {
                                        const newSessions = sessions.filter(session => session.id !== s.id);
                                        setSessions(newSessions);
                                        delete sessionStoreRef.current[s.id];
                                        if (activeSessionId === s.id) {
                                            const lastSession = newSessions[newSessions.length - 1];
                                            if (lastSession) {
                                                switchSession(lastSession.id);
                                            }
                                        }
                                    }
                                }}
                            >×</button>
                        </div>
                    ))}
                    <button
                        className="nexus-btn-icon"
                        title="New session"
                        onClick={() => {
                            const newId = Date.now().toString();
                            setSessions([...sessions, { id: newId, name: `Session ${sessions.length + 1}` }]);
                            switchSession(newId);
                        }}
                    >+</button>
                </div>

                <div className="chat-container" style={{ flex: 1, overflowY: 'auto' }}>
                    {messages.length === 0 && (
                        <IdleState brandIcon={Icons.Nexus} />
                    )}

                    {messages.map((msg, idx) => {
                        if (msg.isCompacted) {
                            return (
                                <MessageView
                                    key={idx}
                                    message={msg}
                                    userIcon={Icons.User}
                                    assistantIcon={Icons.Nexus}
                                    archiveIcon={Icons.Archive}
                                    fileIcon={Icons.File}
                                />
                            );
                        }

                        return (
                            <MessageView
                                key={idx}
                                message={msg}
                                userIcon={Icons.User}
                                assistantIcon={Icons.Nexus}
                                archiveIcon={Icons.Archive}
                                fileIcon={Icons.File}
                            >

                                {msg.plan && (
                                    <details
                                        open
                                        className="plan-card"
                                        style={{
                                            border: '1px solid var(--vscode-widget-border)',
                                            borderRadius: '6px',
                                            overflow: 'hidden',
                                            marginTop: '10px',
                                            background: 'var(--vscode-editor-background)'
                                        }}
                                    >
                                        <summary
                                            className="plan-card-header"
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                padding: '10px 15px',
                                                background: 'var(--vscode-editorGroupHeader-tabsBackground)',
                                                cursor: 'pointer',
                                                outline: 'none',
                                                userSelect: 'none',
                                                fontWeight: 'bold',
                                                borderBottom: '1px solid var(--vscode-widget-border)'
                                            }}
                                        >
                                            <span className="nexus-flex-row">{Icons.Clipboard} Master Implementation Plan</span>
                                            <span style={{ fontSize: '11px', color: 'var(--nexus-subtext)', fontWeight: 'normal' }}>
                                                {msg.plan.implementationTasks.length} Tasks (Click to fold)
                                            </span>
                                        </summary>
                                        {/* Execution-mode toolbar.
                                            Plan mode (default): user clicks Execute on each task individually.
                                            Autonomy mode: user clicks Run All; queue advances on taskCompleted.
                                            Future v2.6 governance: an admin portal will gate the available
                                            options here. The state shape is intentionally simple so an
                                            admin restriction can clamp the dropdown without refactoring.

                                            Class modifiers:
                                              - is-autonomy: autonomy mode selected (visual accent on toolbar)
                                              - is-running:  queue has tasks pending (stronger accent + pulse) */}
                                        <div
                                            className={
                                                'execution-mode-toolbar' +
                                                (executionMode === 'autonomy' ? ' is-autonomy' : '') +
                                                (autonomyQueue.length > 0 ? ' is-running' : '')
                                            }
                                        >
                                            <label
                                                htmlFor="execution-mode-select"
                                                className="execution-mode-toolbar__label"
                                            >
                                                Mode:
                                            </label>
                                            <select
                                                id="execution-mode-select"
                                                className="execution-mode-toolbar__select"
                                                value={executionMode}
                                                onChange={(e) => {
                                                    const next = e.target.value as 'plan' | 'autonomy';
                                                    // If user switches mid-run, halt the current autonomy queue
                                                    // first — they're explicitly opting out of "run them all".
                                                    if (executionMode === 'autonomy' && next === 'plan') {
                                                        haltAutonomyRun();
                                                    }
                                                    setExecutionMode(next);
                                                }}
                                                disabled={autonomyQueue.length > 0}
                                                title={autonomyQueue.length > 0
                                                    ? 'Cannot change mode while autonomy run is in progress. Click Halt first.'
                                                    : 'Choose how tasks are executed.'}
                                            >
                                                <option value="plan">Implementation Plan (review each)</option>
                                                <option value="autonomy">Autonomy (run all)</option>
                                            </select>

                                            {/* Thinking-mode pill.
                                                Bulk toggle for all three agents (planner + coder + verifier).
                                                State derived from thinkingMode flags via aggregateThinkingState:
                                                  - 'on'    🧠 Deep thinking      — all three thinking
                                                  - 'off'   ⚡ Speed mode          — all three skip thinking
                                                  - 'mixed' 🧠 Custom (some on)   — set per-agent in settings
                                                Per-agent control lives in VS Code settings; the "Advanced"
                                                link opens that settings page filtered. */}
                                            {(() => {
                                                const state = aggregateThinkingState(thinkingMode);
                                                const label =
                                                    state === 'on'    ? '🧠 Deep thinking' :
                                                    state === 'off'   ? '⚡ Speed mode' :
                                                                        '🧠 Custom (some on)';
                                                const tooltipBase =
                                                    state === 'on'    ? 'All agents (Planner, Coder, Verifier) are reasoning deeply before responding. Most accurate; slower. Click to switch all to Speed mode.' :
                                                    state === 'off'   ? 'All agents skip extended reasoning for 2-3x faster responses. Click to switch all back to Deep thinking.' :
                                                                        'Per-agent thinking customized via settings. Click to switch all to Speed mode (overrides per-agent choices).';
                                                return (
                                                    <>
                                                        <button
                                                            type="button"
                                                            className={
                                                                'execution-mode-toolbar__thinking-pill' +
                                                                (state === 'on'    ? ' is-on'    : '') +
                                                                (state === 'off'   ? ' is-off'   : '') +
                                                                (state === 'mixed' ? ' is-mixed' : '')
                                                            }
                                                            aria-pressed={state === 'on'}
                                                            title={tooltipBase}
                                                            onClick={() => {
                                                                const next = bulkToggleFromState(state);
                                                                // Optimistic local update — host will echo
                                                                // back the authoritative state via
                                                                // thinkingModeChanged, which will reconcile.
                                                                setThinkingMode(next);
                                                                vscode.postMessage({
                                                                    type: 'setThinkingMode',
                                                                    planner:  next.planner,
                                                                    coder:    next.coder,
                                                                    verifier: next.verifier,
                                                                });
                                                            }}
                                                        >
                                                            {label}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="execution-mode-toolbar__thinking-advanced"
                                                            title="Open VS Code settings to customize thinking mode per agent (Planner / Coder / Verifier independently)."
                                                            onClick={() => {
                                                                vscode.postMessage({ type: 'openThinkingSettings' });
                                                            }}
                                                        >
                                                            Advanced…
                                                        </button>
                                                    </>
                                                );
                                            })()}

                                            {executionMode === 'autonomy' && autonomyQueue.length === 0 && (
                                                <button
                                                    className="execution-mode-toolbar__run-all"
                                                    onClick={startAutonomyRun}
                                                    title="Run all remaining tasks in order. Will stop on the first task the verifier rejects after retries."
                                                >
                                                    ▶ Run All Tasks
                                                </button>
                                            )}

                                            {autonomyQueue.length > 0 && (
                                                <>
                                                    <span
                                                        className="execution-mode-toolbar__queue-counter"
                                                        aria-live="polite"
                                                    >
                                                        Running · {autonomyQueue.length} task{autonomyQueue.length === 1 ? '' : 's'} remaining
                                                    </span>
                                                    <button
                                                        className="execution-mode-toolbar__halt"
                                                        onClick={haltAutonomyRun}
                                                        title="Stop dispatching subsequent tasks. The currently-running task will finish on its own."
                                                    >
                                                        ⏸ Halt
                                                    </button>
                                                </>
                                            )}
                                        </div>

                                        {autonomyError && (
                                            <div className="execution-mode-toolbar__error-banner">
                                                <span>⏸ {autonomyError.message}</span>
                                                <button
                                                    className="execution-mode-toolbar__error-banner-dismiss"
                                                    onClick={() => setAutonomyError(null)}
                                                    title="Dismiss this banner"
                                                >Dismiss</button>
                                            </div>
                                        )}

                                        <div className="task-list" style={{ padding: '12px' }}>
                                            {msg.plan.implementationTasks.map((rawTask, tIdx) => {
                                                const isObj = typeof rawTask !== 'string';
                                                const taskObj = isObj ? (rawTask as ProjectTask) : null;

                                                // Hotfix (post-2B): the previous derivation `taskObj?.step ?? rawTask`
                                                // produced a taskKey that COLLIDED across tasks when:
                                                //   (a) the model returned multiple tasks with empty `step` (e.g.,
                                                //       17 tasks all keyed by ""), or
                                                //   (b) two tasks happened to share the same step text.
                                                // Symptom: clicking Execute on one task showed all tasks as
                                                // "running" because they all read the same dictionary entry.
                                                //
                                                // Fix: derive taskKey from the task's POSITION in the plan
                                                // (always unique). The original step text is preserved as
                                                // taskTitle (used for display) and taskTitleForBackend (sent
                                                // alongside `task: taskKey` so SpecManager.markTaskCompleted
                                                // can still sync the .nexus/specs/<feature>/tasks.md checkbox
                                                // by matching on the human-readable title).
                                                //
                                                // Plain-string tasks (legacy format) keep using the string
                                                // itself as the key — they're rare, usually unique, and
                                                // changing their behavior risks breaking older flows.
                                                const taskKey = taskObj ? `task-${tIdx}` : (rawTask as string);
                                                const taskTitle = taskObj ? taskObj.step : (rawTask as string);
                                                const taskTitleForBackend = taskTitle; // sent as `taskTitle` field
                                                const taskFile = taskObj ? taskObj.file : "";
                                                const taskReq = taskObj ? taskObj.relatedRequirement : "";

                                                const taskPrompt = taskObj
                                                    ? `Task: ${taskObj.step}\nTarget File: ${taskObj.file}\nRelated PRD Requirement: ${taskReq}\n\nDetailed Instructions: ${taskObj.detailedInstructions}`
                                                    : (rawTask as string);

                                                const status = taskStatuses[taskKey];

                                                // Autonomy queue visibility: a task is "queued"
                                                // when an autonomy run is in progress AND the
                                                // task is in the queue but not the current head.
                                                // The head is in 'reviewing' status already
                                                // (shown via the status pill); queued-after-head
                                                // tasks need a separate visual cue so the user
                                                // doesn't click their Execute buttons mid-run.
                                                const isQueuedBehindHead = autonomyQueue.length > 1 &&
                                                    autonomyQueue.indexOf(taskKey) > 0;

                                                return (
                                                    <details
                                                        key={tIdx}
                                                        className={
                                                            'nexus-task-card' +
                                                            (isQueuedBehindHead ? ' is-queued' : '')
                                                        }
                                                        // Auto-open if not yet started or currently running.
                                                        // Behavior preserved from pre-Phase-1.5 code.
                                                        open={!status || status === 'reviewing' || status === 'error'}
                                                    >
                                                        {/* Header (always visible). Number + title on the left,
                                                            activity badge + status pill on the right. */}
                                                        <summary className="nexus-task-card-summary">
                                                            <div className="nexus-task-card-title">
                                                                <span className="nexus-task-card-number">{tIdx + 1}.</span>
                                                                <span className="nexus-task-card-title-text">{taskTitle}</span>
                                                            </div>

                                                            <div className="nexus-task-card-actions">
                                                                {/* Live activity count: shows N cards when this
                                                                    task has tool activity. Useful when the task
                                                                    is collapsed — user can see at-a-glance
                                                                    activity to look at. */}
                                                                {cardsByTaskKey.groups[taskKey] && cardsByTaskKey.groups[taskKey]!.length > 0 && (
                                                                    <span className="task-activity-badge" title={t("chat.tool_activity_count_tooltip") || "Tool calls"}>
                                                                        {cardsByTaskKey.groups[taskKey]!.length} {(cardsByTaskKey.groups[taskKey]!.length === 1) ? 'call' : 'calls'}
                                                                    </span>
                                                                )}
                                                                {/* Status pills — Phase 1.5 unifies all 5 status
                                                                    states into a single .nexus-status-pill
                                                                    vocabulary with semantic variants. Replaces
                                                                    the previous 5 distinct inline-style patterns. */}
                                                                {status === 'reviewing' && (
                                                                    <span className="nexus-status-pill reviewing">
                                                                        <span className="spin">{Icons.Loader}</span>
                                                                        {t("chat.working")}
                                                                    </span>
                                                                )}
                                                                {status === 'approved' && (
                                                                    <span className="nexus-status-pill approved">
                                                                        {Icons.CheckCircle} Approved
                                                                    </span>
                                                                )}
                                                                {status === 'rejected' && (
                                                                    <span className="nexus-status-pill rejected">
                                                                        {Icons.XCircle} Rejected
                                                                    </span>
                                                                )}
                                                                {status === 'error' && (
                                                                    <span className="nexus-status-pill error">
                                                                        {Icons.Warning} Error
                                                                    </span>
                                                                )}
                                                                {status === 'undone' && (
                                                                    <span className="nexus-status-pill reverted">
                                                                        {Icons.Undo} Reverted
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </summary>

                                                        {/* Body (collapsible). */}
                                                        <div className="nexus-task-card-body">

                                                            {/* Context & Prompts */}
                                                            <div>
                                                                {taskObj && <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontFamily: 'monospace', marginBottom: '4px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>{Icons.File} {taskFile}</div>}
                                                                {taskReq && (
                                                                    <div style={{ fontSize: '10px', color: 'var(--vscode-textLink-foreground)', fontStyle: 'italic', background: 'var(--vscode-textCodeBlock-background)', padding: '2px 6px', borderRadius: '4px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                                                        {Icons.Link} Ref: {taskReq}
                                                                    </div>
                                                                )}

                                                                {taskObj && taskObj.detailedInstructions && (
                                                                    <details style={{ marginTop: '8px', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                                                                        <summary style={{ cursor: 'pointer', outline: 'none', userSelect: 'none', fontWeight: 'bold', opacity: 0.8 }}>{t("chat.view_prompt_instructions")}</summary>
                                                                        <div style={{ marginTop: '6px', padding: '8px', borderLeft: '2px solid var(--vscode-editorIndentGuide-activeBackground)', background: 'var(--vscode-editor-inactiveSelectionBackground)', whiteSpace: 'pre-wrap', borderRadius: '0 4px 4px 0' }}>
                                                                            {taskObj.detailedInstructions}
                                                                        </div>
                                                                    </details>
                                                                )}
                                                            </div>

                                                            {/* AI Execution Steps */}
                                                            {taskSteps[taskKey] && taskSteps[taskKey].length > 0 && (
                                                                <div className="agent-steps-container" style={{ background: 'var(--vscode-input-background)', padding: '8px', borderRadius: '6px', border: '1px solid var(--vscode-input-border)' }}>
                                                                    <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--nexus-subtext)', marginBottom: '6px', textTransform: 'uppercase' }}>{t("chat.swarm_execution_logs")}</div>
                                                                    {taskSteps[taskKey].map((step, sIdx) => (
                                                                        <div key={sIdx} className="agent-step-card" style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px 8px', borderLeft: '2px solid var(--vscode-editorIndentGuide-activeBackground)', marginLeft: '4px' }}>
                                                                            <div className="agent-step-header" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                                                <span className="step-icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: step.type === 'error' ? 'var(--vscode-testing-iconFailed)' : step.type === 'success' ? 'var(--vscode-testing-iconPassed)' : step.type === 'heal' ? 'var(--vscode-charts-orange)' : 'var(--vscode-symbolIcon-propertyForeground)' }}>
                                                                                    {step.type === 'search' && Icons.Search}
                                                                                    {step.type === 'read' && Icons.Read}
                                                                                    {step.type === 'analyze' && Icons.Code}
                                                                                    {step.type === 'error' && Icons.Alert}
                                                                                    {step.type === 'heal' && Icons.Wrench}
                                                                                    {step.type === 'success' && Icons.CheckCircle}
                                                                                </span>
                                                                                <span className="step-desc" style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--vscode-foreground)' }}>{step.description}</span>
                                                                            </div>
                                                                            {step.details && (
                                                                                <div className="agent-step-details" style={{ paddingLeft: '22px', fontSize: '10.5px', color: 'var(--vscode-descriptionForeground)', whiteSpace: 'pre-wrap', lineHeight: '1.5', marginTop: '4px' }}>
                                                                                    {step.details}
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}

                                                            {/* AI Reasoning Stream.
                                                                Renders as markdown so
                                                                Coordinator status messages
                                                                ("### Attempt 1 of 2",
                                                                "✅ **Verification Passed!**")
                                                                show as headers and emphasis
                                                                rather than literal markdown
                                                                tokens. The model's natural
                                                                language reasoning tokens
                                                                are interleaved as ordinary
                                                                paragraphs, so the visual
                                                                hierarchy comes from the
                                                                Coordinator separators. */}
                                                            {taskReasoning[taskKey] && (
                                                                <details open style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '6px' }}>
                                                                    <summary style={{ cursor: 'pointer', outline: 'none', userSelect: 'none', fontSize: '11px', fontWeight: 'bold', color: 'var(--nexus-subtext)' }}>
                                                                        {Icons.Brain} View AI Reasoning
                                                                    </summary>
                                                                    <div className="reasoning-content markdown-body" style={{ marginTop: '8px', fontSize: '11px' }}>
                                                                        <ReactMarkdown>{taskReasoning[taskKey] || ''}</ReactMarkdown>
                                                                    </div>
                                                                </details>
                                                            )}

                                                            {/* Per-task tool cards (Phase 1 affinity).
                                                                Renders the cards that resolve to this
                                                                taskKey via the backend→webview taskId
                                                                mapping. Only shown when there's at
                                                                least one card; structurally identical
                                                                to the global-region rendering pre-
                                                                affinity. */}
                                                            {cardsByTaskKey.groups[taskKey] && cardsByTaskKey.groups[taskKey]!.length > 0 && (
                                                                <div className="tool-call-cards-region per-task" data-task-key={taskKey}>
                                                                    {cardsByTaskKey.groups[taskKey]!.map(state => (
                                                                        <ToolCallCard key={state.callId} state={state} />
                                                                    ))}
                                                                </div>
                                                            )}

                                                            {terminalStreams[taskKey] && (
                                                                <div style={{ marginTop: '8px' }}>
                                                                    <CommandCard
                                                                        command={taskObj ? taskObj.step : taskKey}
                                                                        output={terminalStreams[taskKey] ?? ''}
                                                                        status={
                                                                            status === 'error' ? 'error' :
                                                                            status === 'approved' ? 'success' :
                                                                            'running'
                                                                        }
                                                                    />
                                                                </div>
                                                            )}

                                                            {/* Bottom Action Bar */}
                                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', paddingTop: '10px', borderTop: '1px dashed var(--vscode-widget-border)' }}>
                                                                {taskSummaries[taskKey] ? (
                                                                    <div style={{ fontSize: '11px', color: 'var(--vscode-textLink-foreground)' }}>ℹ️ {taskSummaries[taskKey]}</div>
                                                                ) : <div />}

                                                                {/* 🚀 Render Task-Specific Tokens */}
                                                                {taskTokens[taskKey] && (
                                                                    <div style={{ fontSize: '10px', color: 'var(--nexus-subtext)', display: 'flex', gap: '8px', background: 'var(--vscode-editor-inactiveSelectionBackground)', padding: '2px 6px', borderRadius: '4px' }}>
                                                                        <span title={t("tokens.task_input")}>📥 {taskTokens[taskKey].prompt.toLocaleString()}</span>
                                                                        <span title={t("tokens.task_output")}>📤 {taskTokens[taskKey].completion.toLocaleString()}</span>
                                                                    </div>
                                                                )}

                                                                <div className="nexus-flex-block-gap-2">
                                                                    {/* 1. Approved State: Diff and Undo */}
                                                                    {status === 'approved' && taskFiles[taskKey] && (
                                                                        <>
                                                                            <button className="micro-btn" onClick={() => vscode.postMessage({ type: 'showDiff', filepath: taskFiles[taskKey] })} title={t("buttons.compare_changes")}>⚖️ Diff</button>
                                                                            <button className="micro-btn" onClick={() => vscode.postMessage({ type: 'undoTaskEdit', task: taskKey })} title={t("buttons.undo_edit")}>↩️ Undo</button>
                                                                        </>
                                                                    )}

                                                                    {/* 2. Rejected State: Allow Manual Feedback */}
                                                                    {status === 'rejected' && (
                                                                        <button className="micro-btn" onClick={() => vscode.postMessage({ type: 'requestRevision', task: taskKey, taskTitle: taskTitleForBackend, codingStyle: codingStyleRef.current })}>💬 Provide Feedback</button>
                                                                    )}

                                                                    {/* 3. Executable States: Empty, Rejected, or Error */}
                                                                    {(!status || status === 'rejected' || status === 'error') && (
                                                                        <>
                                                                            {/* Only show Verify if it has never been run */}
                                                                            {!status && (
                                                                                <button
                                                                                    className="micro-btn"
                                                                                    disabled={isQueuedBehindHead}
                                                                                    onClick={() => { setTaskStatuses(prev => ({ ...prev, [taskKey]: 'reviewing' })); setTaskSteps(prev => ({ ...prev, [taskKey]: [] })); setTaskReasoning(prev => ({ ...prev, [taskKey]: '' })); vscode.postMessage({ type: 'verifyTask', task: taskKey, taskTitle: taskTitleForBackend, prompt: taskPrompt }); }}
                                                                                    title={isQueuedBehindHead
                                                                                        ? 'Queued — autonomy run is in progress. Halt it to interact with this task manually.'
                                                                                        : t("buttons.verify_manual")}
                                                                                >👁️ Verify</button>
                                                                            )}

                                                                            {/* Main Execution / Retry Button */}
                                                                            <button
                                                                                className="micro-btn btn-primary"
                                                                                style={{ background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' }}
                                                                                disabled={isQueuedBehindHead}
                                                                                onClick={() => { dispatchTaskExecution(taskKey, taskTitleForBackend, taskPrompt); }}
                                                                                title={isQueuedBehindHead
                                                                                    ? 'Queued — autonomy run is in progress. Halt it to interact with this task manually.'
                                                                                    : t("buttons.auto_execute")}
                                                                            >
                                                                                {status === 'rejected' || status === 'error' ? '▶ Retry Execution' : '▶ Execute'}
                                                                            </button>
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </div>

                                                        </div>
                                                    </details>
                                                );
                                            })}
                                        </div>
                                    </details>
                                )}
                            </MessageView>
                        );
                    })}

                    {Object.entries(terminalStreams).map(([key, stream]) => {
                        if (key.startsWith("Auto-Test") && stream.trim().length > 0) {
                            return (
                                <div key={key} className="nexus-message assistant" style={{ marginBottom: '15px' }}>
                                    <div className="nexus-message-header assistant" style={{ marginBottom: '8px' }}>
                                        {Icons.Nexus} NEXUS TERMINAL: {key}
                                    </div>
                                    <div style={{
                                        background: '#0d1117',
                                        padding: '10px',
                                        borderRadius: '6px',
                                        border: '1px solid #30363d',
                                        fontFamily: 'monospace',
                                        fontSize: '10.5px',
                                        color: '#c9d1d9',
                                        maxHeight: '300px',
                                        overflowY: 'auto',
                                        whiteSpace: 'pre-wrap'
                                    }}>
                                        {stream}
                                    </div>
                                </div>
                            );
                        }
                        return null;
                    })}

                    {/*
                      Per-task tool-card affinity (Phase 1):
                      Cards now render INSIDE each task's expansion via the
                      `cardsByTaskKey.groups[taskKey]` lookup. This region
                      is the FALLBACK that catches "unscoped" cards — events
                      that arrived before the `taskExecutionStarted` mapping
                      was processed (rare race condition), or cards from
                      code paths that don't go through executeTask.

                      Hidden when there are no unscoped cards.
                    */}
                    {cardsByTaskKey.unscoped.length > 0 && (
                        <div className="tool-call-cards-region unscoped" aria-label="Unscoped tool activity">
                            <div className="tool-cards-region-label">
                                {t("chat.tool_activity_unscoped") || "Tool activity"}
                            </div>
                            {cardsByTaskKey.unscoped.map(state => (
                                <ToolCallCard key={state.callId} state={state} />
                            ))}
                        </div>
                    )}

                    {/* P1.4: hook fire cards. Hooks fire OUTSIDE the
                        agent task workflow (saves, schedules, manual
                        runs) so they don't go in the per-task region.
                        Renders inline in the chat thread, sorted by
                        start time, so the user sees them in the order
                        they triggered.

                        Hidden when no hooks have fired this session. */}
                    {hookFireState.size > 0 && (
                        <div className="hook-fires-region" aria-label="Hook activity">
                            <div className="tool-cards-region-label">
                                {t("hooks.activity_label") || "Hook activity"}
                            </div>
                            {sortedHookFires(hookFireState).map(state => (
                                <HookFireCard key={state.hookFireId} state={state} />
                            ))}
                        </div>
                    )}

                    {loading && !agentStatus && (
                        <div className="nexus-message assistant">
                            <div className="nexus-message-header assistant">{Icons.Nexus} NEXUS</div>
                            <div className="nexus-message-content" style={{ display: 'flex', gap: '8px', color: 'var(--nexus-subtext)' }}>
                                {Icons.Loader} Thinking...
                            </div>
                        </div>
                    )}

                    {/* 🔥 THE GLASS BRAIN: Semantic & AST Context Visualizer */}
                    {loading && glassBrainContext && (
                        <div className="glass-brain-container">
                            <details className="glass-brain-details" open>
                                <summary>
                                    {Icons.Brain} Nexus Glass Brain: Context Retrieved
                                </summary>
                                <div className="glass-brain-content">
                                    {/* We split the context by lines to apply the success 
                  styling to the mathematical RRF scores automatically. 
                */}
                                    {glassBrainContext.split('\n').map((line, i) => {
                                        if (line.includes('RRF Score:')) {
                                            const [text, score] = line.split('RRF Score:');
                                            return <div key={i}>{text} <span className="glass-brain-score">RRF: {score}</span></div>;
                                        }
                                        return <div key={i}>{line}</div>;
                                    })}
                                </div>
                            </details>
                        </div>
                    )}

                    {pendingCommand && (
                        <div className="nexus-security-card">
                            <div className="nexus-security-card-header">
                                {Icons.Alert} Security Interceptor: Action Required
                            </div>
                            <div className="nexus-security-card-body">
                                <div className="nexus-security-card-message">{pendingCommand.message}</div>
                                <code className="nexus-security-card-command">
                                    $ {pendingCommand.command}
                                </code>
                                <div className="nexus-security-card-actions">
                                    <button className="nexus-btn-primary nexus-btn--equal" onClick={() => {
                                        // 🔥 UX FIX: Wipe all old terminal streams so the new execution starts on a clean slate!
                                        setTerminalStreams({});
                                        vscode.postMessage({ type: 'approveCommand', command: pendingCommand.command });
                                        setPendingCommand(null);
                                    }}>Allow</button>
                                    <button className="nexus-btn-secondary nexus-btn--equal nexus-btn--danger" onClick={() => {
                                        setPendingCommand(null);
                                        setAgentStatus("🛑 Command blocked by user.");
                                        vscode.postMessage({ type: 'rejectCommand' });
                                    }}>Block</button>
                                </div>
                            </div>
                        </div>
                    )}

                    <div ref={chatEndRef} />
                </div>

                {agentStatus && (
                    <WorkingBar
                        status={agentStatus}
                        onCancel={() => {
                            vscode.postMessage({ type: 'cancelTask' });
                        }}
                    />
                )}

                {/* P0: bash_exec confirmation prompt. The agent loop is
                    paused waiting on the user's click; rendered above
                    the security banner so it's the most urgent thing
                    in the chat area. Three buttons:
                      - Block: deny this command, agent moves on (or
                        retries with different approach)
                      - Allow: run this command only
                      - Allow always for this task: set per-session
                        autopilot so subsequent bash_exec calls in the
                        SAME task skip the prompt. Resets at next
                        user message. */}
                {pendingBashApproval && (
                    <BashApprovalCard
                        command={pendingBashApproval.command}
                        onRespond={(mode) => {
                            vscode.postMessage({ type: 'respondBashApproval', mode });
                            setPendingBashApproval(null);
                        }}
                    />
                )}

                {/* M-8: security-monitor-unavailable banner. Renders
                    above the pending-edits dock so it's the first thing
                    the user sees after a failed gate decision. Three
                    actions: Retry (clear banner; user re-runs whatever
                    they were doing), Disable for session (skip the LLM
                    judge until VS Code restart — fail-open), Dismiss
                    (acknowledge but keep gate on). Choosing Disable
                    surfaces a follow-up confirmation in copy so the
                    user understands the security implication. */}
                {securityBanner && (
                    <div
                        className="nexus-security-banner"
                        role="alert"
                        style={{
                            margin: '8px 12px',
                            padding: '10px 12px',
                            borderRadius: 'var(--nexus-radius-md, 6px)',
                            background: 'rgba(204, 167, 0, 0.10)',
                            border: '1px solid rgba(204, 167, 0, 0.35)',
                            color: 'var(--vscode-foreground)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px'
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {Icons.Warning}
                            <strong style={{ fontSize: 'var(--nexus-text-md, 12px)' }}>
                                {t('security_banner.title') || 'Security gate offline'}
                            </strong>
                        </div>
                        <div style={{ fontSize: 'var(--nexus-text-sm, 11px)', color: 'var(--nexus-subtext)', lineHeight: 1.4 }}>
                            {t('security_banner.body') ||
                                'The Security Monitor model is not responding, so commands are being blocked by default. Retry once your model is back, switch to a different model in Settings, or disable the gate for this session.'}
                            {securityBanner.command ? (
                                <div style={{ marginTop: '4px', fontFamily: 'monospace', fontSize: 'var(--nexus-text-xs, 10px)', opacity: 0.75, wordBreak: 'break-all' }}>
                                    {t('security_banner.last_command') || 'Last blocked command'}: {securityBanner.command.substring(0, 120)}
                                    {securityBanner.command.length > 120 ? '…' : ''}
                                </div>
                            ) : null}
                        </div>
                        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                            <button
                                className="nexus-btn-secondary nexus-btn--compact"
                                onClick={() => setSecurityBanner(null)}
                            >
                                {t('security_banner.retry') || 'Retry'}
                            </button>
                            <button
                                className="nexus-btn-secondary nexus-btn--compact"
                                onClick={() => {
                                    if (securityGateDisabled) { return; }
                                    const ok = window.confirm(
                                        t('security_banner.confirm_disable') ||
                                        'Disable the security gate for this session? Commands the agent runs will execute without the LLM safety check until you reload VS Code.'
                                    );
                                    if (ok) {
                                        setSecurityGateDisabled(true);
                                        setSecurityBanner(null);
                                        vscode.postMessage({ type: 'setSecurityGate', enabled: false });
                                    }
                                }}
                                title={securityGateDisabled
                                    ? (t('security_banner.already_disabled') || 'Already disabled for this session')
                                    : (t('security_banner.disable_session') || 'Disable for this session')}
                                disabled={securityGateDisabled}
                            >
                                {securityGateDisabled
                                    ? (t('security_banner.disabled_label') || 'Gate disabled')
                                    : (t('security_banner.disable_session') || 'Disable for session')}
                            </button>
                            <button
                                className="nexus-btn-secondary nexus-btn--compact"
                                onClick={() => setSecurityBanner(null)}
                                title={t('security_banner.dismiss') || 'Dismiss'}
                            >
                                ×
                            </button>
                        </div>
                    </div>
                )}

                {pendingEdits && (
                    <div className="review-dock nexus-flex-shrink-0">
                        <div className="review-header">
                            <span className="nexus-flex-row">{Icons.Warning} Review Proposed Edits</span>
                            <span style={{ cursor: 'pointer', color: 'var(--nexus-subtext)' }} onClick={() => setPendingEdits(null)}>×</span>
                        </div>
                        <div style={{ maxHeight: '80px', overflowY: 'auto' }}>
                            {pendingEdits.map((edit, i) => (
                                <div key={i} className="review-file">
                                    <span className="nexus-flex-row">{Icons.File} {edit.filepath}</span>
                                    <span style={{ color: 'var(--nexus-border)' }}>({edit.action})</span>
                                </div>
                            ))}
                        </div>
                        <div className="review-actions">
                            <button className="nexus-btn-primary nexus-btn--compact" onClick={() => { setLoading(true); setAgentStatus("Committing..."); vscode.postMessage({ type: 'commitAtomicEdits', edits: pendingEdits }); }}>✅ Commit All</button>
                            <button className="nexus-btn-secondary nexus-btn--compact" onClick={() => setPendingEdits(null)}>{t("common.cancel")}</button>
                        </div>
                    </div>
                )}

                <div className="nexus-input-shell">
                    <div className={`nexus-input-composer${metaMode ? ' meta-active' : ''}`}>
                        {attachedContexts.length > 0 && (
                            <div className="context-chips">
                                {attachedContexts.map((ctx, idx) => (
                                    <FileChip
                                        key={idx}
                                        filepath={ctx.file}
                                        language={ctx.language}
                                        title={ctx.code}
                                        onRemove={() => setAttachedContexts(prev => prev.filter((_, i) => i !== idx))}
                                    />
                                ))}
                            </div>
                        )}

                        {showMentionMenu && mentionResults.length > 0 && (
                            <div className="mention-menu">
                                <div className="mention-header">{t("mention.attach_file_context")}</div>
                                {mentionResults.map(res => (
                                    <div key={res} className="mention-item" onClick={() => {
                                        vscode.postMessage({ type: 'readFileContext', file: res });
                                        setShowMentionMenu(false);
                                        const words = input.split(' ');
                                        words.pop();
                                        setInput(words.join(' ') + (words.length > 0 ? ' ' : ''));
                                        document.getElementById('chat-input')?.focus();
                                    }}>
                                        <span className="nexus-flex-row">{Icons.File} {res}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        <textarea
                            className="nexus-input-textarea"
                            id="chat-input" value={input} onChange={handleInput} onKeyDown={handleKeyDown}
                            placeholder={metaMode ? t("chat.input.placeholder_meta_mode") : t("chat.input.placeholder")}
                            rows={1}
                        />

                        {loading ? (
                            <button
                                className="nexus-send-button stop"
                                onClick={() => { setLoading(false); vscode.postMessage({ type: 'cancelTask' }); }}
                                title={t("buttons.stop_generation")}
                            >■</button>
                        ) : (
                            <button
                                className="nexus-send-button"
                                onClick={() => handleSubmit()}
                                disabled={!input.trim() && attachedContexts.length === 0}
                                title="Send"
                            >{Icons.UpArrow}</button>
                        )}
                    </div>

                    <div className="micro-toolbar">
                        <div className="toolbar-group">
                            <select className="micro-select" value={selectedModel} onChange={(e) => { setSelectedModel(e.target.value); vscode.postMessage({ type: 'setModel', value: e.target.value }); }}>
                                {availableModels.length === 0 && <option value="">{t("common.loading")}</option>}
                                {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
                            </select>

                            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: isAutopilot ? 'var(--vscode-terminal-ansiMagenta)' : 'var(--nexus-subtext)', cursor: 'pointer', fontWeight: isAutopilot ? 'bold' : 'normal', marginLeft: '8px' }}>
                                <div style={{
                                    width: '24px', height: '14px', borderRadius: '10px', background: isAutopilot ? 'var(--vscode-terminal-ansiMagenta)' : 'var(--vscode-input-background)',
                                    position: 'relative', transition: '0.2s'
                                }}>
                                    <div style={{
                                        width: '10px', height: '10px', borderRadius: '50%', background: 'white',
                                        position: 'absolute', top: '2px', left: isAutopilot ? '12px' : '2px', transition: '0.2s'
                                    }}></div>
                                </div>
                                <input
                                    type="checkbox"
                                    checked={isAutopilot}
                                    onChange={(e) => setIsAutopilot(e.target.checked)}
                                    style={{ display: 'none' }}
                                />
                                Autopilot
                            </label>
                        </div>

                        <div className="toolbar-group" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--vscode-charts-orange)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.9, padding: 0 }}
                                onClick={() => vscode.postMessage({ type: 'generateAndRunTests', autopilot: isAutopilot })}
                                title={t("buttons.auto_run_tests")}>
                                Auto-Test
                            </button>

                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--vscode-testing-iconPassed)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.9, padding: 0 }}
                                onClick={() => vscode.postMessage({ type: 'runGlobalCompiler' })}
                                title={t("buttons.strict_compile")}>
                                {Icons.Build} Compile
                            </button>
                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--vscode-foreground)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.7, padding: 0 }}
                                onClick={handleClearHistory}
                                title={t("buttons.clear_chat")}>
                                {Icons.Trash} Clear
                            </button>
                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-foreground)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.7, padding: 0 }}
                                onClick={() => vscode.postMessage({ type: 'refreshCodeLens' })}
                                title={t("buttons.refresh_ui")}>
                                {Icons.Refresh}
                            </button>

                            {/* 🚀 Render Global Tokens */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', color: 'var(--nexus-subtext)', borderLeft: '1px solid var(--vscode-widget-border)', paddingLeft: '8px', marginLeft: '4px' }}>
                                <span title={t("tokens.total_input")}>📥 {globalTokens.prompt.toLocaleString()}</span>
                                <span title={t("tokens.total_output")}>📤 {globalTokens.completion.toLocaleString()}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ========================================================= */}
            {/* 📋 TAB 2: THE REQUIREMENT HUB (BUILDER)                   */}
            {/* ========================================================= */}
            <div className="nexus-spec-view" style={{ display: activeTab === 'builder' ? 'flex' : 'none' }}>
                {/* PR 3.1: phase stepper. Renders only when phaseState
                    has been hydrated from initState — before that there's
                    nothing meaningful to show. The stepper sits sticky at
                    the top of the spec column. */}
                {phaseState && <PhaseStepper state={phaseState as PhaseStateForStepper} />}

                {(!requirements || requirements.trim() === '') && !isGeneratingReqs && (
                    <div className="nexus-spec-intro">
                        <h3 className="nexus-spec-intro-title">{t("project.start_new")}</h3>
                        <p className="nexus-spec-intro-description">{t("project.describe_idea")}</p>

                        {builderContexts.length > 0 && (
                            <div className="context-chips" style={{ marginBottom: '5px' }}>
                                {builderContexts.map((ctx, idx) => (
                                    <FileChip
                                        key={idx}
                                        filepath={ctx.file}
                                        language={ctx.language}
                                        title={ctx.code}
                                        onRemove={() => setBuilderContexts(prev => prev.filter((_, i) => i !== idx))}
                                    />
                                ))}
                            </div>
                        )}

                        <div className="nexus-spec-attach-row">
                            <button
                                className="nexus-spec-attach-button"
                                onClick={() => { searchTargetRef.current = 'builder'; setIsSearching(true); }}
                            >
                                {Icons.Plus} Attach Specs / API Docs
                            </button>
                        </div>

                        {isSearching && (
                            <div className="nexus-spec-search-panel">
                                <div className="nexus-spec-search-panel-header">
                                    <span className="nexus-spec-search-panel-title">{t("search.header")}</span>
                                    <button className="nexus-spec-search-close" onClick={() => setIsSearching(false)} title="Close">✖</button>
                                </div>
                                <input
                                    autoFocus
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) => {
                                        setSearchQuery(e.target.value);
                                        if (e.target.value.length > 2) { vscode.postMessage({ type: 'searchFiles', query: e.target.value }); }
                                        else setSearchResults([]);
                                    }}
                                    placeholder={t("search.placeholder_files")}
                                    className="nexus-spec-search-input"
                                />
                                <div className="nexus-spec-search-results">
                                    {searchResults.map(res => (
                                        <button key={res} className="nexus-spec-search-result"
                                            onClick={() => vscode.postMessage({ type: 'readFileContext', file: res })}>
                                            {Icons.File} {res}
                                        </button>
                                    ))}
                                    {searchQuery.length > 2 && searchResults.length === 0 && <div className="nexus-spec-search-empty">{t("search.no_files_found")}</div>}
                                </div>
                            </div>
                        )}

                        <textarea
                            className="nexus-spec-textarea"
                            value={rawIdea}
                            onChange={(e) => setRawIdea(e.target.value)}
                            placeholder="e.g. Build a checkout system. Use the attached Stripe API docs for the exact JSON payloads..."
                            rows={5}
                        />
                        <button
                            className="nexus-spec-cta"
                            onClick={() => {
                                if (!rawIdea.trim()) { return; }
                                setReqLogs([]);
                                setIsGeneratingReqs(true);

                                let contextStr = "";
                                if (builderContexts.length > 0) {
                                    contextStr = builderContexts.map(c => `File: ${c.file}\n\`\`\`${c.language}\n${c.code}\n\`\`\``).join('\n\n');
                                }

                                vscode.postMessage({ type: 'generateRequirements', text: rawIdea, context: contextStr });
                            }}
                        >
                            {Icons.Wand} Auto-Generate RAG-Enhanced PRD
                        </button>
                    </div>
                )}

                {(isGeneratingReqs || isGeneratingDesign) && (
                    <div className="plan-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', marginTop: '10px' }}>
                        <div className="plan-card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 15px' }}>
                            <div className="nexus-flex-block-row-gap-3">
                                <div style={{ color: 'var(--vscode-button-background)' }}>{Icons.Loader}</div>
                                <span style={{ fontWeight: 'bold' }}>
                                    {isGeneratingReqs ? 'Drafting PRD...' : 'Architecting System Design...'}
                                    <span style={{ color: 'var(--nexus-subtext)', marginLeft: '8px', fontFamily: 'monospace' }}>[{formatTime(specTimer)}]</span>
                                </span>
                            </div>
                            <button
                                className="nexus-spec-progress-stop"
                                onClick={() => {
                                    vscode.postMessage({ type: 'cancelTask' });
                                    setIsGeneratingReqs(false);
                                    setIsGeneratingDesign(false);
                                }}
                            >
                                {Icons.Stop} Stop
                            </button>
                        </div>
                        <div className="nexus-spec-progress">
                            {reqLogs.map((log, i) => {
                                /* Phase 1.9: log-line semantic kind moved from inline-style ternary
                                   to a data-attribute. CSS owns the colors via [data-kind] selectors,
                                   keeping the JSX clean. */
                                let kind: 'header' | 'error' | 'property' | 'default' = 'default';
                                if (log.includes('━━━')) { kind = 'header'; }
                                else if (log.includes('❌') || log.includes('Error')) kind = 'error';
                                else if (log.includes('Domain:') || log.includes('Product Type:')) kind = 'property';
                                return <div key={i} className="nexus-spec-progress-line" data-kind={kind}>{log}</div>;
                            })}
                        </div>
                    </div>
                )}

                {(requirements && requirements.trim() !== '') && !design && !isGeneratingReqs && !isGeneratingDesign && (
                    <div className="nexus-flex-col">
                        <div className="nexus-flex-between-shrink">
                            <span className="nexus-flex-row nexus-text-success-bold">
                                {phaseState?.requirements === 'approved'
                                    ? <>{Icons.CheckCircle} PRD approved · .nexus/specs/main/requirements.md</>
                                    : <>{Icons.FilePen} PRD draft · .nexus/specs/main/requirements.md</>}
                            </span>
                            <div className="nexus-flex-block-gap-3">
                                <button className="nexus-btn-ghost" onClick={() => setIsEditingReqs(!isEditingReqs)}>
                                    {isEditingReqs ? <>{Icons.Eye} Preview</> : <>{Icons.Edit} Edit</>}
                                </button>
                                <button className="nexus-btn-ghost"
                                    onClick={() => {
                                        setRequirements(''); setRawIdea(''); setReqLogs([]); setIsEditingReqs(false);
                                        vscode.postMessage({ type: 'updateRequirements', text: '' });
                                    }}>
                                    {Icons.Restart} Start Over
                                </button>
                            </div>
                        </div>

                        {!isEditingReqs ? (
                            <div className="markdown-body nexus-scroll-preview">
                                <ReactMarkdown>{cleanTraceabilityTags(requirements)}</ReactMarkdown>
                            </div>
                        ) : (
                            <>
                                {/* PR 3.1: EARS helper bar. Lets the user
                                    drop in WHEN / IF / WHILE / WHERE /
                                    THE SYSTEM SHALL at the cursor with
                                    a single click. Compliance convention:
                                    keywords stay UPPERCASE ENGLISH in
                                    every locale. */}
                                <EarsHelper
                                    onInsert={(snippet) => {
                                        const ta = requirementsTextareaRef.current;
                                        if (!ta) { return; }
                                        const { value, cursorPos } = insertAtCursor(ta, snippet);
                                        setRequirements(value);
                                        vscode.postMessage({ type: 'updateRequirements', text: value });
                                        // Restore cursor position after React re-render. We schedule
                                        // through requestAnimationFrame so the DOM has the new value
                                        // before we reposition the caret.
                                        requestAnimationFrame(() => {
                                            ta.focus();
                                            ta.setSelectionRange(cursorPos, cursorPos);
                                        });
                                    }}
                                />
                                <textarea
                                    ref={requirementsTextareaRef}
                                    className="nexus-textarea-mono"
                                    value={requirements}
                                    onChange={(e) => { setRequirements(e.target.value); vscode.postMessage({ type: 'updateRequirements', text: e.target.value }); }}
                                />
                            </>
                        )}

                        {/* Phase-gate UX: explicit Approve / Reject before unlocking the next phase. See audit §11. */}
                        {phaseState?.requirements !== 'approved' ? (
                            <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
                                <button
                                    className="nexus-btn-secondary"
                                    onClick={() => vscode.postMessage({ type: 'rejectPhase', phase: 'requirements' })}
                                >
                                    <span className="nexus-flex-row">{Icons.Restart} Reject &amp; Regenerate</span>
                                </button>
                                <button
                                    className="nexus-btn-primary"
                                    onClick={() => vscode.postMessage({ type: 'approvePhase', phase: 'requirements' })}
                                >
                                    <span className="nexus-flex-row">{Icons.Check} Approve PRD</span>
                                </button>
                            </div>
                        ) : (
                            <button
                                className="nexus-spec-cta"
                                style={{ flexShrink: 0 }}
                                onClick={() => {
                                    setIsGeneratingDesign(true);
                                    setReqLogs([]);
                                    vscode.postMessage({ type: 'generateDesign', requirements });
                                }}
                            >
                                {Icons.Sparkles} Generate Architecture Design
                            </button>
                        )}
                    </div>
                )}

                {(requirements && design) && !isGeneratingDesign && (
                    <div className="nexus-flex-col">
                        <div className="nexus-flex-between-shrink">
                            <span className="nexus-flex-row nexus-text-success-bold">
                                {phaseState?.design === 'approved'
                                    ? <>{Icons.CheckCircle} Design approved · .nexus/specs/main/</>
                                    : <>{Icons.FilePen} Design draft · .nexus/specs/main/</>}
                            </span>
                            <div className="nexus-flex-block-gap-3">
                                <button className="nexus-btn-ghost" onClick={() => setIsEditingDesign(!isEditingDesign)}>
                                    {isEditingDesign ? <>{Icons.Eye} Preview</> : <>{Icons.Edit} Edit Design</>}
                                </button>
                                <button className="nexus-btn-ghost"
                                    onClick={() => {
                                        setRequirements(''); setDesign(''); setRawIdea(''); setReqLogs([]); setIsEditingReqs(false); setIsEditingDesign(false);
                                        vscode.postMessage({ type: 'updateRequirements', text: '' });
                                    }}>
                                    {Icons.Restart} Start Over
                                </button>
                            </div>
                        </div>

                        {!isEditingDesign ? (
                            <div className="markdown-body nexus-scroll-preview">
                                <h2>1. Product Requirements</h2>
                                <ReactMarkdown>{cleanTraceabilityTags(requirements)}</ReactMarkdown>
                                <hr />
                                <h2>2. System Design</h2>
                                <ReactMarkdown>{cleanTraceabilityTags(design)}</ReactMarkdown>
                            </div>
                        ) : (
                            <textarea
                                className="nexus-textarea-mono"
                                value={design}
                                onChange={(e) => { setDesign(e.target.value); vscode.postMessage({ type: 'updateDesign', text: e.target.value }); }}
                            />
                        )}

                        {isGeneratingTasks ? (
                            <div className="nexus-spec-tasks-loader">
                                <div className="nexus-flex-block-row-gap-3">
                                    {Icons.Loader} Drafting Master Implementation Plan... <span style={{ fontFamily: 'monospace' }}>[{formatTime(specTimer)}]</span>
                                </div>
                                <button
                                    className="nexus-spec-tasks-loader-stop"
                                    onClick={() => { vscode.postMessage({ type: 'cancelTask' }); setIsGeneratingTasks(false); }}
                                >
                                    Stop
                                </button>
                            </div>
                        ) : (
                            // Phase-gate UX for the design → tasks transition. See audit §11.
                            phaseState?.design !== 'approved' ? (
                                <div className="nexus-action-row">
                                    <button
                                        className="nexus-btn-secondary"
                                        onClick={() => vscode.postMessage({ type: 'rejectPhase', phase: 'design' })}
                                    >
                                        <span className="nexus-flex-row">{Icons.Restart} Reject &amp; Regenerate</span>
                                    </button>
                                    <button
                                        className="nexus-btn-primary"
                                        onClick={() => vscode.postMessage({ type: 'approvePhase', phase: 'design' })}
                                    >
                                        <span className="nexus-flex-row">{Icons.Check} Approve Design</span>
                                    </button>
                                </div>
                            ) : (
                                <div className="nexus-action-row">
                                    <button
                                        className="nexus-btn-secondary"
                                        onClick={() => {
                                            vscode.postMessage({ type: 'updateRequirements', text: requirements });
                                            vscode.postMessage({ type: 'updateDesign', text: design });
                                            setActiveTab('coder');
                                        }}
                                    >
                                        <span className="nexus-flex-row">{Icons.Save} Just Save</span>
                                    </button>
                                    <button
                                        className="nexus-btn-primary"
                                        onClick={() => {
                                            setIsGeneratingTasks(true);
                                            vscode.postMessage({ type: 'generateProjectTasks' });
                                        }}
                                    >
                                        <span className="nexus-flex-row">{Icons.Zap} Generate Implementation Plan</span>
                                    </button>
                                </div>
                            )
                        )}
                    </div>
                )}
            </div>

            {/* ========================================================= */}
            {/* ✨ TAB 3: AGENT SKILLS & RULES (.nexusrules)              */}
            {/* ========================================================= */}
            <div className="nexus-skill-view" style={{ display: activeTab === 'rules' ? 'flex' : 'none' }}>
                <div className="nexus-skill-view-inner">
                    <h3 className="nexus-skill-view-header">{t("skills.header")}</h3>
                    <p className="nexus-skill-view-description">
                        Define custom behaviors, preferred libraries, and architectural rules. The AI will strictly follow these instructions when writing code. Saves to <code>.nexusrules</code>.
                    </p>

                    <textarea
                        className="nexus-skill-view-textarea"
                        value={nexusRules}
                        onChange={(e) => setNexusRules(e.target.value)}
                        placeholder="e.g., Always use Tailwind CSS. Never use class components. Prefer Axios over fetch. All functions must include JSDoc comments."
                    />

                    <div className="nexus-skill-view-actions">
                        <button
                            className="nexus-btn-primary"
                            onClick={() => vscode.postMessage({ type: 'saveNexusRules', text: nexusRules })}
                        >
                            Save Agent Skills
                        </button>
                    </div>
                </div>
            </div>

            {/* ========================================================= */}
            {/* 🌌 TAB 4: THE SPLIT-VIEW MATRIX (Traceability Map)        */}
            {/* ========================================================= */}
            <div style={{ display: activeTab === 'Map' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'hidden', background: '#0d1117' }}>

                {/* Header Controls with New Map Toggles */}
                <div style={{ padding: '15px', borderBottom: '1px solid #30363d', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(13, 17, 23, 0.8)', zIndex: 1000, flexShrink: 0 }}>
                    <div>
                        <h3 style={{ margin: 0, color: 'white' }}>{t("traceability.header")}</h3>
                        <div style={{ fontSize: '11px', color: '#8b949e', marginTop: '4px' }}>{t("traceability.subheader")}</div>
                    </div>

                    {/*  TRACEABILITY TOGGLES */}
                    <div className="nexus-map-toggle-group">
                        <button
                            className={`nexus-map-toggle${activeMapType === 'codeMap' ? ' active' : ''}`}
                            onClick={() => setActiveMapType('codeMap')}
                        >{t("buttons.code_ast")}</button>

                        <button
                            className={`nexus-map-toggle${activeMapType === 'reqMap' ? ' active' : ''}`}
                            onClick={() => setActiveMapType('reqMap')}
                        >
                            Requirements {(isGraphLoading && activeMapType === 'reqMap') && <span className="spin">{Icons.Loader}</span>}
                        </button>

                        <button
                            className={`nexus-map-toggle${activeMapType === 'combinedMap' ? ' active' : ''}`}
                            onClick={() => setActiveMapType('combinedMap')}
                        >
                            Combined Traceability {(isGraphLoading && activeMapType === 'combinedMap') && <span className="spin">{Icons.Loader}</span>}
                        </button>
                    </div>

                    {/* Granularity toggle. Only relevant for codeMap.
                        File: one node per file (architecture overview).
                        Symbol: function/class nodes per file (call-trace level).
                        v2.8 will replace the symbol path with full
                        Tree-sitter cross-language symbol graph + cluster
                        coloring + cross-file call edges. */}
                    {activeMapType === 'codeMap' && (
                        <div className="nexus-map-toggle-group" style={{ marginLeft: '8px' }}>
                            <button
                                className={`nexus-map-toggle${graphGranularity === 'file' ? ' active' : ''}`}
                                onClick={() => setGraphGranularity('file')}
                                title="Show one node per file. Edges represent imports between files. Best for architecture overview."
                            >📄 Files</button>
                            <button
                                className={`nexus-map-toggle${graphGranularity === 'symbol' ? ' active' : ''}`}
                                onClick={() => setGraphGranularity('symbol')}
                                title="Show function and class nodes within each file. Best for tracing call chains. Full cross-file call graph ships with v2.8."
                            >ƒ Symbols</button>
                        </div>
                    )}

                    <div className="nexus-flex-block-gap-2">
                        <button style={{ background: 'transparent', border: '1px solid #58a6ff', color: '#58a6ff', cursor: 'pointer', fontSize: '12px', padding: '6px 12px', borderRadius: '6px' }} onClick={() => vscode.postMessage({ type: 'requestWorkspaceGraph' })}>↻ Refresh</button>
                    </div>
                </div>

                {/* Split View Body */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>

                    {/* LEFT SIDE: WebGL 3D Canvas (60% Width) */}
                    <div ref={graphContainerRef} style={{ flex: 3, position: 'relative', borderRight: '1px solid #30363d', overflow: 'hidden' }}>

                        {/* 🚀 THE NEW HUD OVERLAY: Shows exactly what the LLM is doing in the background! */}
                        {isGraphLoading && (
                            <div style={{
                                position: 'absolute',
                                bottom: '30px',
                                left: '50%',
                                transform: 'translateX(-50%)',
                                background: 'rgba(13, 17, 23, 0.95)',
                                border: '1px solid #58a6ff',
                                borderRadius: '8px',
                                padding: '16px 24px',
                                zIndex: 1000,
                                boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 15px rgba(88, 166, 255, 0.15)',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                gap: '8px',
                                minWidth: '320px'
                            }}>
                                <div className="nexus-flex-block-row-gap-3">
                                    <div style={{ color: '#58a6ff' }} className="spin">{Icons.Loader}</div>
                                    <span style={{ color: 'white', fontWeight: 'bold', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '1px' }}>AI Matrix Synthesis</span>
                                </div>
                                <div style={{ color: '#58a6ff', fontSize: '11px', fontFamily: 'monospace', opacity: 0.9, textAlign: 'center', padding: '4px 0' }}>
                                    {agentStatus || 'Vectorizing abstract requirements...'}
                                </div>
                            </div>
                        )}

                        {!graphData ? (
                            <div style={{ color: '#8b949e', position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>{t("search.scanning_workspace")}</div>
                        ) : (
                            <Suspense fallback={
                                <div style={{ color: '#8b949e', position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
                                    {t("traceability.loading_3d") || 'Loading 3D engine...'}
                                </div>
                            }>
                                <MapGraph
                                    mapKey={`${activeMapType}::${graphGranularity}`}
                                    width={graphDims.width}
                                    height={graphDims.height}
                                    graphData={visualGraphData}
                                    onNodeClick={(node) => {
                                        // Single click → populate side panel.
                                        // Symbol nodes encode their parent file as
                                        // "filepath::symbolName" — split here to
                                        // surface both pieces in the panel.
                                        if (node.group === 'external_lib') { return; }
                                        const [maybeFilepath, maybeSymbol] = node.id.split('::');
                                        const filepath = maybeSymbol !== undefined ? maybeFilepath : node.id;
                                        const symbol = maybeSymbol !== undefined ? maybeSymbol : undefined;
                                        const sel: { id: string; name: string; group: string | undefined; filepath?: string; symbol?: string } = {
                                            id: node.id,
                                            name: node.id.split('/').pop() || node.id,
                                            group: node.group,
                                        };
                                        if (filepath !== undefined) { sel.filepath = filepath; }
                                        if (symbol !== undefined) { sel.symbol = symbol; }
                                        setSelectedGraphNode(sel);

                                        // Also keep the existing scroll-to-card
                                        // behavior so users who relied on the old
                                        // jump-to-detail UX don't lose it.
                                        const safeId = `node-card-${node.id.replace(/[^a-zA-Z0-9-]/g, '-')}`;
                                        const el = document.getElementById(safeId);
                                        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
                                        if (el) {
                                            el.style.borderColor = '#58a6ff';
                                            setTimeout(() => { el.style.borderColor = 'var(--vscode-input-border)'; }, 1500);
                                        }
                                    }}
                                    onNodeDoubleClick={(node) => {
                                        // Double-click → open the file (and jump
                                        // to the symbol if this was a symbol-
                                        // level node). External libs aren't on
                                        // disk, so we skip those.
                                        if (node.group === 'external_lib') { return; }
                                        const [maybeFilepath, maybeSymbol] = node.id.split('::');
                                        const filepath = maybeSymbol !== undefined ? maybeFilepath : node.id;
                                        if (!filepath) { return; }
                                        const payload: { type: string; filepath: string; symbol?: string } = {
                                            type: 'openFile',
                                            filepath,
                                        };
                                        if (maybeSymbol !== undefined) { payload.symbol = maybeSymbol; }
                                        vscode.postMessage(payload);
                                    }}
                                />
                            </Suspense>
                        )}
                    </div>

                    {/* RIGHT SIDE: Text Detail Sidebar (40% Width) */}
                    <div style={{ flex: 2, overflowY: 'auto', padding: '15px', display: 'flex', flexDirection: 'column', gap: '15px', background: 'var(--vscode-editor-background)', position: 'relative' }}>
                        {/* Selected-node detail card. Single click on a graph
                            node populates this; double click opens the file
                            in the editor. The card stays visible until the
                            user picks another node or dismisses it. */}
                        {selectedGraphNode && (
                            <div className="nexus-graph-selected-card">
                                <div className="nexus-graph-selected-card__header">
                                    <span className="nexus-graph-selected-card__kind">
                                        {selectedGraphNode.symbol
                                            ? (selectedGraphNode.group === 'class' ? '© Class' : 'ƒ Function')
                                            : '📄 File'}
                                    </span>
                                    <button
                                        type="button"
                                        className="nexus-graph-selected-card__close"
                                        onClick={() => setSelectedGraphNode(null)}
                                        title="Clear selection"
                                    >×</button>
                                </div>
                                <div className="nexus-graph-selected-card__name">
                                    {selectedGraphNode.symbol ?? selectedGraphNode.name}
                                </div>
                                {selectedGraphNode.symbol && selectedGraphNode.filepath && (
                                    <div className="nexus-graph-selected-card__parent">
                                        in <code>{selectedGraphNode.filepath}</code>
                                    </div>
                                )}
                                <div className="nexus-graph-selected-card__actions">
                                    <button
                                        type="button"
                                        className="nexus-graph-selected-card__open-btn"
                                        onClick={() => {
                                            if (!selectedGraphNode.filepath) { return; }
                                            const payload: { type: string; filepath: string; symbol?: string } = {
                                                type: 'openFile',
                                                filepath: selectedGraphNode.filepath,
                                            };
                                            if (selectedGraphNode.symbol) { payload.symbol = selectedGraphNode.symbol; }
                                            vscode.postMessage(payload);
                                        }}
                                        disabled={!selectedGraphNode.filepath}
                                    >
                                        ↗ Open in Editor
                                    </button>
                                    <span className="nexus-graph-selected-card__hint">
                                        Tip: double-click any node to jump straight to its source.
                                    </span>
                                </div>
                            </div>
                        )}

                        {isGraphLoading && (
                            <div style={{ background: 'rgba(88, 166, 255, 0.1)', border: '1px solid rgba(88, 166, 255, 0.3)', borderRadius: '6px', padding: '10px', display: 'flex', gap: '10px', alignItems: 'center' }}>
                                <div style={{ color: '#58a6ff' }} className="spin">{Icons.Loader}</div>
                                <div style={{ fontSize: '11px', color: '#c9d1d9', lineHeight: '1.4' }}>
                                    <strong>{t("traceability.matrix_computing_label")}</strong> {t("traceability.matrix_computing")}
                                </div>
                            </div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                <div style={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--nexus-subtext)', textTransform: 'uppercase' }}>
                                    {activeMapType === 'codeMap' ? 'File Anatomy' : 'Relational Node Data'}
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--nexus-subtext)' }}>
                                    {activeMapType === 'combinedMap' && 'Showing Tasks & Vector Math'}
                                </div>
                            </div>

                            {/* 🚀 GLOBAL PROJECT TDD BUTTON */}
                            <button
                                onClick={() => vscode.postMessage({ type: 'generateProjectTests' })}
                                title={t("buttons.tdd_master_suite")}
                                style={{
                                    background: '#238636',
                                    border: '1px solid rgba(240, 246, 252, 0.1)',
                                    color: '#ffffff',
                                    borderRadius: '6px',
                                    padding: '6px 12px',
                                    cursor: 'pointer',
                                    fontSize: '12px',
                                    fontWeight: 'bold',
                                    boxShadow: '0 2px 5px rgba(0,0,0,0.2)'
                                }}
                            >
                                <span className="nexus-flex-row">{Icons.Flask} Generate Project TDD</span>
                            </button>
                        </div>

                        {!graphData ? null :
                            Array.isArray(graphData.nodes) ? (
                                graphData.nodes.length === 0 ? (
                                    <div style={{ textAlign: 'center', color: 'var(--nexus-subtext)', marginTop: '40px', padding: '20px', background: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
                                        No requirements found. Go to the <strong>Spec</strong> tab to generate a PRD and Implementation Plan first!
                                    </div>
                                ) : (
                                    graphData.nodes.map((node: any) => {
                                        // 1. Get Badge Styles based on Group
                                        const safeGroup = (node.group || node.type || 'file').toLowerCase();
                                        let badge = { bg: 'rgba(255,255,255,0.1)', color: '#ccc', icon: '🔹' };
                                        if (safeGroup === 'epic') { badge = { bg: 'rgba(245, 66, 141, 0.15)', color: '#f5428d', icon: '🎯' }; }
                                        if (safeGroup === 'story') { badge = { bg: 'rgba(81, 207, 102, 0.15)', color: '#51cf66', icon: '📖' }; }
                                        if (safeGroup === 'criteria') { badge = { bg: 'rgba(51, 154, 240, 0.15)', color: '#339af0', icon: '✅' }; }
                                        if (safeGroup === 'task') { badge = { bg: 'rgba(252, 163, 17, 0.15)', color: '#fca311', icon: '⚡' }; }
                                        if (safeGroup === 'file') { badge = { bg: 'rgba(139, 148, 158, 0.15)', color: '#8b949e', icon: '📄' }; }
                                        if (safeGroup === 'api') { badge = { bg: 'rgba(156, 39, 176, 0.15)', color: '#e0a8ff', icon: '🔌' }; }
                                        if (safeGroup === 'model') { badge = { bg: 'rgba(0, 188, 212, 0.15)', color: '#80deea', icon: '🗄️' }; }

                                        // 2. Extract Relational Connections (Safe for WebGL Object mutation)
                                        const edges = graphData.edges || [];
                                        const nodeEdges = edges.filter((e: any) => {
                                            const srcId = typeof e.source === 'object' ? e.source.id : e.source;
                                            const tgtId = typeof e.target === 'object' ? e.target.id : e.target;
                                            return srcId === node.id || tgtId === node.id;
                                        });

                                        return (
                                            <div key={node.id} id={`node-card-${node.id.replace(/[^a-zA-Z0-9-]/g, '-')}`} className="nexus-input-panel">

                                                {/* Header with Badge */}
                                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                                                    <span style={{ background: badge.bg, color: badge.color, padding: '2px 8px', borderRadius: '12px', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', flexShrink: 0, marginTop: '2px' }}>
                                                        {badge.icon} {node.group}
                                                    </span>
                                                    <div style={{ color: 'var(--vscode-foreground)', fontWeight: 'bold', fontSize: '13px', lineHeight: '1.4', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                                                        {node.label || node.id}
                                                    </div>
                                                </div>

                                                {/* System ID */}
                                                <div style={{ fontSize: '10px', color: 'var(--nexus-subtext)', marginTop: '8px', fontFamily: 'monospace', background: 'rgba(0,0,0,0.2)', padding: '4px', borderRadius: '4px', wordBreak: 'break-all' }}>
                                                    ID: {node.id}
                                                </div>

                                                {/* THE UPGRADE: Relational Connections & Vector Math */}
                                                {nodeEdges.length > 0 && (
                                                    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed var(--vscode-input-border)' }}>
                                                        <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--nexus-subtext)', marginBottom: '6px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>{Icons.Link} CONNECTIONS</div>
                                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                            {nodeEdges.map((edge: any, idx: number) => {
                                                                const srcId = typeof edge.source === 'object' ? edge.source.id : edge.source;
                                                                const tgtId = typeof edge.target === 'object' ? edge.target.id : edge.target;

                                                                const isOutgoing = srcId === node.id;
                                                                const connectedId = isOutgoing ? tgtId : srcId;

                                                                // Format the Math!
                                                                const isSemantic = edge.isSemantic;
                                                                const weight = edge.weight ? (edge.weight * 100).toFixed(1) + '%' : null;

                                                                return (
                                                                    <div key={idx} style={{ fontSize: '11px', color: 'var(--vscode-textLink-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.03)', padding: '4px 6px', borderRadius: '4px' }}>
                                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>
                                                                            <span style={{ color: 'var(--nexus-subtext)', flexShrink: 0 }}>{isOutgoing ? '→' : '←'}</span>
                                                                            <span title={connectedId} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{connectedId}</span>
                                                                        </div>

                                                                        {/* Render the Mathematical Cosine Similarity Score */}
                                                                        {isSemantic && weight && (
                                                                            <span style={{ color: '#fca311', fontWeight: 'bold', fontSize: '10px', background: 'rgba(252, 163, 17, 0.1)', padding: '2px 6px', borderRadius: '4px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                                                                {Icons.Brain} {weight} match
                                                                            </span>
                                                                        )}
                                                                        {!isSemantic && (
                                                                            <span style={{ color: '#51cf66', fontSize: '10px', opacity: 0.8, flexShrink: 0 }}>
                                                                                Hard Link
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })
                                )) : (
                                Object.entries(graphData).map(([filepath, node]: [string, any]) => {
                                    if (filepath === 'nodes' || filepath === 'edges') { return null; }
                                    const safeId = `node-card-${filepath.replace(/[^a-zA-Z0-9-]/g, '-')}`;

                                    //  THE FIX: Intelligently split the path for clean typography
                                    const isWindows = filepath.includes('\\');
                                    const parts = filepath.split(isWindows ? '\\' : '/');
                                    const fileName = parts.pop() || filepath;
                                    const dirName = parts.length > 0 ? parts.join(isWindows ? '\\' : '/') : '';

                                    return (
                                        <div id={safeId} key={filepath} className="nexus-input-panel">

                                            {/* Beautiful Header Layout */}
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                                                {/* 🚀 THE FIX: Added flex: 1 and minWidth: 0 to force the ellipsis to trigger */}
                                                <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingRight: '10px', flex: 1, minWidth: 0 }}>
                                                    <span style={{ color: 'var(--vscode-foreground)', fontWeight: 'bold', fontSize: '13px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', display: 'inline-flex', alignItems: 'center', gap: '6px' }} title={fileName}>
                                                        {Icons.File} {fileName}
                                                    </span>
                                                    {dirName && (
                                                        <span style={{ color: 'var(--nexus-subtext)', fontSize: '10px', marginTop: '2px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontFamily: 'monospace' }} title={dirName}>
                                                            {dirName}
                                                        </span>
                                                    )}
                                                </div>

                                                <button
                                                    style={{ background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', border: '1px solid var(--vscode-button-border, transparent)', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                                    title={t("buttons.open_in_editor")}
                                                    onClick={() => vscode.postMessage({ type: 'openFile', filepath: filepath })}>
                                                    OPEN {Icons.ExternalLink}
                                                </button>
                                            </div>

                                            {/* File Attributes */}
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '11px' }}>
                                                {node.exports?.length > 0 && (
                                                    <div style={{ background: 'rgba(81, 207, 102, 0.1)', color: '#51cf66', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(81, 207, 102, 0.3)' }}>
                                                        <strong>{t("node_details.exports_label")}</strong> {node.exports.join(', ')}
                                                    </div>
                                                )}
                                                {node.classes?.length > 0 && (
                                                    <div style={{ background: 'rgba(252, 163, 17, 0.1)', color: '#fca311', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(252, 163, 17, 0.3)' }}>
                                                        <strong>{t("node_details.classes_label")}</strong> {node.classes.join(', ')}
                                                    </div>
                                                )}
                                                {node.functions?.length > 0 && (
                                                    <div style={{ background: 'rgba(51, 154, 240, 0.1)', color: '#339af0', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(51, 154, 240, 0.3)' }}>
                                                        <strong>{t("node_details.functions_label")}</strong> {node.functions.join(', ')}
                                                    </div>
                                                )}
                                                {node.imports?.length > 0 && (
                                                    <div style={{ width: '100%', marginTop: '4px', color: 'var(--nexus-subtext)' }}>
                                                        ↳ Imports: {node.imports.map((imp: string) => imp.replace(/['"]/g, '')).join(', ')}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })
                            )
                        }
                    </div>
                </div>
            </div>
        </AppShell>
    );
}