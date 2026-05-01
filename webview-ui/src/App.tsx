import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import './App.css';
import ReactMarkdown from 'react-markdown';
import ForceGraph3D from 'react-force-graph-3d';
import { FileChip } from './components/FileChip';
import { ErrorBanner } from './components/ErrorBanner';
import { CommandCard } from './components/CommandCard';
import { WorkingBar } from './components/WorkingBar';
// Component 2B-4: tool-call card rendering and state management.
import { ToolCallCard } from './components/ToolCallCard';
import { applyToolEvent, type ToolCallState, type ToolLifecycleEvent } from './toolEvents';
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
export const cleanTraceabilityTags = (text: string) => {
    if (!text) return '';

    let cleaned = text;

    // 1. Format Models & APIs using standard Markdown Headers
    cleaned = cleaned.replace(/<model\s+id="([^"]+)">/gi, '\n### 🗄️ Model: `$1`\n\n');
    cleaned = cleaned.replace(/<\/model>/gi, '\n\n');

    cleaned = cleaned.replace(/<api\s+method="([^"]+)"\s+route="([^"]+)">/gi, '\n### 🔌 `$1` `$2`\n\n');
    cleaned = cleaned.replace(/<\/api>/gi, '\n\n');

    // 2. Consolidate Responses into clean, single-line bullets (No asterisks)
    cleaned = cleaned.replace(/<response>[\s\S]*?<code>([^<]+)<\/code>[\s\S]*?<description>([^<]+)<\/description>[\s\S]*?<\/response>/gi, '- 📤 Status `$1`: $2\n');

    // 3. Format Params & Fields as minimalist code elements
    cleaned = cleaned.replace(/<(field|param)\s+([^>]+)\/?>/gi, (match, tag, attrs) => {
        const nameMatch = attrs.match(/name="([^"]+)"/i);
        const typeMatch = attrs.match(/type="([^"]+)"/i);
        const descMatch = attrs.match(/description="([^"]+)"/i);
        const requiredMatch = attrs.match(/required="([^"]+)"/i);

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
    cleaned = cleaned.replace(/<(request)>/gi, '\n####Request Body\n\n');
    cleaned = cleaned.replace(/<(query)>/gi, '\n####Query Parameters\n\n');
    cleaned = cleaned.replace(/<\/(request|query)>/gi, '\n\n');

    // 5. Format descriptions as standard blockquotes
    cleaned = cleaned.replace(/<description>([^<]+)<\/description>/gi, '\n> $1\n\n');

    // 6. Strip all REMAINING invisible structural matrix tags
    cleaned = cleaned.replace(/<\/?(epic|story|criteria|metadata|target_audience|nfr_list|architecture_components|data_models|api_routes|folder_structure|tasks|task|instructions)[^>]*>/gi, '');

    // 7. Enforce strict Markdown spacing (fixes ReactMarkdown choking on lists)
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
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

    const graphContainerRef = useRef<HTMLDivElement>(null);
    const [graphDims, setGraphDims] = useState({ width: 800, height: 600 });

    const [isAutopilot, setIsAutopilot] = useState(false);
    const [sessions, setSessions] = useState<{ id: string, name: string }[]>([{ id: '1', name: 'New Session' }]);
    const [activeSessionId, setActiveSessionId] = useState('1');

    const [terminalStreams, setTerminalStreams] = useState<Record<string, string>>({});

    const [glassBrainContext, setGlassBrainContext] = useState<string>("");
    const [pendingCommand, setPendingCommand] = useState<{ command: string, message: string } | null>(null);


    useEffect(() => {
        if (!showGraph || !graphContainerRef.current) return;

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
        if (!graphData) return { nodes: [], links: [] };

        const nodes: any[] = [];
        const links: any[] = [];
        const nodeSet = new Set<string>();

        // FORMAT 1: New Tracability Map (Array Form)
        if (Array.isArray(graphData.nodes) && Array.isArray(graphData.edges)) {
            const validNodeIds = new Set<string>();

            graphData.nodes.forEach((n: any) => {
                let val = 5;
                const nodeGroup = (n.group || n.type || 'file').toLowerCase();

                if (nodeGroup === 'epic') val = 8;
                if (nodeGroup === 'story') val = 6;
                if (nodeGroup === 'criteria') val = 4;
                if (nodeGroup === 'task') val = 7;

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
                    console.warn(`[Graph Firewall] Dropped hallucinated link: ${sourceId} -> ${targetId}`);
                }
            });

            return { nodes, links };
        }

        // FORMAT 2: Fallback for Pure AST Code Map (Dictionary Form)
        Object.entries(graphData).forEach(([filepath, node]: [string, any]) => {
            if (filepath === 'nodes' || filepath === 'edges') return; // Guard clause

            // (folder variable removed in tsconfig hardening — was declared but never read.)
            const filename = filepath.split('/').pop() || '';

            nodes.push({ id: filepath, name: `📄 ${filename}`, group: 'file', val: 5 });
            nodeSet.add(filepath);

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

            node.imports?.forEach((imp: string) => {
                const cleanImp = imp.replace(/['"]/g, '');
                let targetFile = Object.keys(graphData).find(k => k.includes(cleanImp.replace('./', '').replace('../', '')));
                if (targetFile) {
                    links.push({ source: filepath, target: targetFile, color: 'rgba(245, 66, 141, 0.8)' });
                }
            });
        });

        return { nodes, links };
    }, [graphData]);

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
            const data = event.data;

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

            //  TRACEABILITY PAYLOAD CAPTURE

            if (data.type === 'workspaceGraphData') {
                console.log("[DEBUG-MAP-UI] 🟢 Received workspaceGraphData from backend!", data);
            }

            if (data.type === 'workspaceGraphData') {
                try {
                    const parsedPayload = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
                    console.log("[DEBUG-MAP-UI] 🟢 Successfully parsed payload:", parsedPayload);
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
                    console.error("[DEBUG-MAP-UI] 🔴 Failed to parse incoming graph payload:", err);
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
                        if (prev[backendTaskId] === taskKey) return prev;
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
                        if (prev.some(c => c.file === data.file && c.code === data.code)) return prev;
                        return [...prev, { file: data.file, code: data.code, language: data.language }];
                    });
                    setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
                } else {
                    setBuilderContexts(prev => {
                        if (prev.some(c => c.file === data.file && c.code === data.code)) return prev;
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
                if (data.taskStatuses) setTaskStatuses(data.taskStatuses);
                if (data.taskSummaries) setTaskSummaries(data.taskSummaries);
                if (data.taskFiles) setTaskFiles(data.taskFiles);
                if (data.requirements) setRequirements(data.requirements);
                if (data.design) setDesign(data.design);
                if (data.nexusRules) setNexusRules(data.nexusRules);
                if (data.phaseState) setPhaseState(data.phaseState);

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
                if (data.type === 'requirementsGenerated') setIsGeneratingReqs(false);
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
                if (data.currentModel && data.models.includes(data.currentModel)) setSelectedModel(data.currentModel);
                else if (data.models.length > 0) setSelectedModel(data.models[0]);
            }

            if (data.type === 'structureResponse') {
                setActivePlan(data.value);
                setMessages(prev => [...prev, { role: 'assistant', plan: data.value }]);
                setLoading(false);
                setIsGeneratingTasks(false);
                setActiveTab('coder');
            }

            if (data.type === 'statusUpdate') setAgentStatus(data.message);
            if (data.type === 'reviewEdits') { setPendingEdits(data.edits); setLoading(false); }
            if (data.type === 'allTasksCompleted') {
                setPendingEdits(null);
                setMessages(prev => [...prev, { role: 'assistant', content: "✅ Atomic transaction committed successfully." }]);
                setAgentStatus('');
            }
            if (data.type === 'taskCompleted' || data.type === 'taskStatusUpdate') {
                setTaskStatuses(prev => ({ ...prev, [data.task]: data.status }));
                if (data.summary) setTaskSummaries(prev => ({ ...prev, [data.task]: data.summary }));
                if (data.filepath) setTaskFiles(prev => ({ ...prev, [data.task]: data.filepath }));
                if (data.status === 'error') setLoading(false);
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

            if (data.type === 'metaModeChanged') setMetaMode(data.value);
            if (data.type === 'requestReview') setInput(`Please review this code:\n\n\`\`\`\n${data.code}\n\`\`\``);
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
                if (!groups[key]) groups[key] = [];
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

    if (!isLoaded) return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--nexus-subtext)' }}>{t("chat.loading_nexus")}</div>;

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
                            if (val) vscode.postMessage({ type: 'saveApiKey', value: val });
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
        if (textarea) textarea.style.height = 'auto';
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
        if (newId === activeSessionId) return;

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
        <div className="app-wrapper" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
            {/* App header — Phase 1.7 product identity. Replaces the plain
                tiny-header text with a proper brand + status layout. The
                meta-mode indicator (when active) is shown in the right
                status area instead of replacing the brand. */}
            <div className="nexus-app-header">
                <div className="nexus-app-header-brand">
                    <span className="nexus-app-header-brand-icon">{Icons.Nexus}</span>
                    <span className="nexus-app-header-wordmark">NexusCode</span>
                </div>
                <div className={`nexus-app-header-status${metaMode ? ' meta-active' : ''}`}>
                    {metaMode ? (
                        <>
                            {Icons.Warning}
                            <span>SELF-EVOLUTION ACTIVE</span>
                        </>
                    ) : (
                        <>
                            <span className="nexus-app-header-status-dot" />
                            <span>Ready</span>
                        </>
                    )}
                </div>
            </div>

            {/*  TABS HEADER */}
            {/* Tab bar — Phase 1.5 chrome redesign. Replaced 4 inline-styled
                tab buttons (each with its own copy of the active-state
                ternary) with .nexus-tabs / .nexus-tab classes. Active state
                is purely accent-colored bottom border + foreground shift, no
                background change — matches Kiro's restrained tab treatment. */}
            <div className="nexus-tabs">
                <button
                    className={`nexus-tab${activeTab === 'coder' ? ' active' : ''}`}
                    onClick={() => setActiveTab('coder')}
                >
                    Vibe
                </button>
                <button
                    className={`nexus-tab${activeTab === 'builder' ? ' active' : ''}`}
                    onClick={() => setActiveTab('builder')}
                >
                    Spec
                </button>
                <button
                    className={`nexus-tab${activeTab === 'rules' ? ' active' : ''}`}
                    onClick={() => setActiveTab('rules')}
                >
                    Skills
                </button>
                <button
                    className={`nexus-tab${activeTab === 'Map' ? ' active' : ''}`}
                    onClick={() => {
                        setActiveTab('Map');
                        // Only auto-fetch if we have NEVER loaded the map before;
                        // otherwise rely on the manual Refresh button. Preserves
                        // pre-Phase-1.5 behavior to avoid surprising re-fetches.
                        if (!graphPayload) {
                            vscode.postMessage({ type: 'requestWorkspaceGraph' });
                        }
                    }}
                    title={t("buttons.visualize_graph")}
                >
                    Map
                </button>
            </div>

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
                        <div className="nexus-chat-empty">
                            <div className="nexus-chat-empty-icon">
                                {Icons.Nexus}
                            </div>
                            <h3 className="nexus-chat-empty-title">How can I help you build today?</h3>
                            <p className="nexus-chat-empty-hint">
                                Describe what you want to build, ask a question about your codebase, or paste an error you're investigating.
                            </p>
                            <div className="nexus-chat-empty-shortcuts">
                                <span className="nexus-chat-empty-shortcut">@ to attach files</span>
                                <span className="nexus-chat-empty-shortcut">Enter to send</span>
                                <span className="nexus-chat-empty-shortcut">Shift+Enter for newline</span>
                            </div>
                        </div>
                    )}

                    {messages.map((msg, idx) => {
                        if (msg.isCompacted) {
                            return (
                                <details key={idx} className="nexus-message-compacted">
                                    <summary>
                                        {Icons.Archive} Context Compacted (Old messages summarized to save tokens)
                                    </summary>
                                    <div className="nexus-message-compacted-body">
                                        <ReactMarkdown>{msg.content || ''}</ReactMarkdown>
                                    </div>
                                </details>
                            );
                        }

                        return (
                            <div key={idx} className={`nexus-message ${msg.role}`}>
                                <div className={`nexus-message-header ${msg.role}`}>
                                    {msg.role === 'user' ? Icons.User : Icons.Nexus}
                                    {msg.role === 'user' ? 'YOU' : 'NEXUS'}
                                </div>

                                {msg.content && (
                                    <div className="nexus-message-content markdown-body">
                                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                                    </div>
                                )}

                                {msg.role === 'user' && msg.attachments && msg.attachments.length > 0 && (
                                    <div className="message-attachments">
                                        {msg.attachments.map((att, i) => (
                                            <details key={i} className="attachment-details">
                                                <summary className="nexus-flex-row">{Icons.File} {att.file}</summary>
                                                <div className="markdown-body">
                                                    <pre><code className={`language-${att.language}`}>{att.code}</code></pre>
                                                </div>
                                            </details>
                                        ))}
                                    </div>
                                )}

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

                                                return (
                                                    <details
                                                        key={tIdx}
                                                        className="nexus-task-card"
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

                                                            {/* AI Reasoning Stream */}
                                                            {taskReasoning[taskKey] && (
                                                                <details open style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '6px' }}>
                                                                    <summary style={{ cursor: 'pointer', outline: 'none', userSelect: 'none', fontSize: '11px', fontWeight: 'bold', color: 'var(--nexus-subtext)' }}>
                                                                        {Icons.Brain} View AI Reasoning
                                                                    </summary>
                                                                    <div className="reasoning-content" style={{ marginTop: '8px', fontSize: '11px' }}>
                                                                        {taskReasoning[taskKey]}
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
                                                                                <button className="micro-btn" onClick={() => { setTaskStatuses(prev => ({ ...prev, [taskKey]: 'reviewing' })); setTaskSteps(prev => ({ ...prev, [taskKey]: [] })); setTaskReasoning(prev => ({ ...prev, [taskKey]: '' })); vscode.postMessage({ type: 'verifyTask', task: taskKey, taskTitle: taskTitleForBackend, prompt: taskPrompt }); }} title={t("buttons.verify_manual")}>👁️ Verify</button>
                                                                            )}

                                                                            {/* Main Execution / Retry Button */}
                                                                            <button className="micro-btn btn-primary" style={{ background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' }} onClick={() => { setTaskStatuses(prev => ({ ...prev, [taskKey]: 'reviewing' })); setTaskSteps(prev => ({ ...prev, [taskKey]: [] })); setTaskReasoning(prev => ({ ...prev, [taskKey]: '' })); vscode.postMessage({ type: 'executeTask', task: taskKey, taskTitle: taskTitleForBackend, prompt: taskPrompt, codingStyle: codingStyleRef.current }); }} title={t("buttons.auto_execute")}>
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
                            </div>
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
                                        if (e.target.value.length > 2) vscode.postMessage({ type: 'searchFiles', query: e.target.value });
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
                                if (!rawIdea.trim()) return;
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
                                if (log.includes('━━━')) kind = 'header';
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
                            <textarea
                                className="nexus-textarea-mono"
                                value={requirements}
                                onChange={(e) => { setRequirements(e.target.value); vscode.postMessage({ type: 'updateRequirements', text: e.target.value }); }}
                            />
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
                            <ForceGraph3D
                                key={activeMapType}
                                width={graphDims.width}
                                height={graphDims.height}
                                graphData={visualGraphData}
                                nodeAutoColorBy="group"
                                nodeLabel="name"
                                linkDirectionalArrowLength={4}
                                linkDirectionalArrowRelPos={1}
                                linkWidth={(link: any) => link.isSemantic ? 0.5 : 1.5}
                                linkDirectionalParticles={(link: any) => link.isSemantic ? 3 : 0}
                                linkDirectionalParticleWidth={2}
                                linkDirectionalParticleSpeed={0.005}
                                linkColor={(link: any) => link.color}
                                nodeVal="val"
                                backgroundColor="#0d1117"
                                onNodeClick={(node: any) => {
                                    if (node.group !== 'external_lib') {
                                        const safeId = `node-card-${node.id.replace(/[^a-zA-Z0-9-]/g, '-')}`;
                                        const el = document.getElementById(safeId);
                                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });

                                        if (el) {
                                            el.style.borderColor = '#58a6ff';
                                            setTimeout(() => { el.style.borderColor = 'var(--vscode-input-border)'; }, 1500);
                                        }
                                    }
                                }}
                            />
                        )}
                    </div>

                    {/* RIGHT SIDE: Text Detail Sidebar (40% Width) */}
                    <div style={{ flex: 2, overflowY: 'auto', padding: '15px', display: 'flex', flexDirection: 'column', gap: '15px', background: 'var(--vscode-editor-background)', position: 'relative' }}>
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
                                        if (safeGroup === 'epic') badge = { bg: 'rgba(245, 66, 141, 0.15)', color: '#f5428d', icon: '🎯' };
                                        if (safeGroup === 'story') badge = { bg: 'rgba(81, 207, 102, 0.15)', color: '#51cf66', icon: '📖' };
                                        if (safeGroup === 'criteria') badge = { bg: 'rgba(51, 154, 240, 0.15)', color: '#339af0', icon: '✅' };
                                        if (safeGroup === 'task') badge = { bg: 'rgba(252, 163, 17, 0.15)', color: '#fca311', icon: '⚡' };
                                        if (safeGroup === 'file') badge = { bg: 'rgba(139, 148, 158, 0.15)', color: '#8b949e', icon: '📄' };
                                        if (safeGroup === 'api') badge = { bg: 'rgba(156, 39, 176, 0.15)', color: '#e0a8ff', icon: '🔌' };
                                        if (safeGroup === 'model') badge = { bg: 'rgba(0, 188, 212, 0.15)', color: '#80deea', icon: '🗄️' };

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
                                    if (filepath === 'nodes' || filepath === 'edges') return null;
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
        </div>
    );
}