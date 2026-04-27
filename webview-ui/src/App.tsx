import React, { useState, useEffect, useRef, useMemo } from 'react';
import './App.css';
import ReactMarkdown from 'react-markdown';
import ForceGraph3D from 'react-force-graph-3d';
import { LoginModal } from './components/LoginModal';

const vscode = (window as any).acquireVsCodeApi();
let chatTokenBuffer = "";
let lastChatUpdate = Date.now();
let reasoningTokenBuffer = "";
let lastReasoningUpdate = Date.now();

const cleanTraceabilityTags = (text: string) => {
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

const Icons = {
    User: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>,
    Nexus: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>,
    Play: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>,
    Check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>,
    UpArrow: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>,
    Brain: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"></path><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"></path><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"></path><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"></path><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"></path><path d="M3.477 10.896a4 4 0 0 1 .585-.396"></path><path d="M19.938 10.5a4 4 0 0 1 .585.396"></path><path d="M6 18a4 4 0 0 1-1.967-.516"></path><path d="M19.967 17.484A4 4 0 0 1 18 18"></path></svg>,
    Loader: <svg className="spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="4.93" x2="19.07" y2="7.76"></line></svg>,
    Eye: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>,
    Plus: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>,
    Trash: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>,
    Search: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>,
    Read: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>,
    Code: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>,
    Alert: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>,
    Wrench: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>,
    CheckCircle: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>,
    Build: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>,
    Refresh: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>,
};

export default function App() {
    const chatTokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reasoningTokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    //  MAP & TRACEABILITY STATE
    const [graphPayload, setGraphPayload] = useState<any>(null);
    const [activeMapType, setActiveMapType] = useState<'codeMap' | 'reqMap' | 'combinedMap'>('combinedMap');
    const [isGraphLoading, setIsGraphLoading] = useState<boolean>(false);

    const [globalTokens, setGlobalTokens] = useState({ prompt: 0, completion: 0 });
    const [taskTokens, setTaskTokens] = useState<Record<string, { prompt: number, completion: number }>>({});

    const [taskSteps, setTaskSteps] = useState<Record<string, AgentStep[]>>({});

    // 🚀 NEW: Enterprise Auth State (Default to true so it doesn't flash before the backend handshake)
    const [isAuthenticated, setIsAuthenticated] = useState<boolean>(true);
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
    const [graphData, setGraphData] = useState<Record<string, any> | null>(null);

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

            const folder = filepath.split('/')[0] || 'root';
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

            if (data.type === 'authStateChanged') {
                setIsAuthenticated(data.isAuthenticated);
            }

            if (data.type === 'initState') {
                const loadedMsgs = data.messages || [];
                setHasKey(data.hasKey);
                
                // 🚀 Catch initial auth state from backend
                setIsAuthenticated(data.isAuthenticated ?? false); 

                if (data.taskStatuses) setTaskStatuses(data.taskStatuses);
                if (data.taskSummaries) setTaskSummaries(data.taskSummaries);
                if (data.taskFiles) setTaskFiles(data.taskFiles);
                if (data.requirements) setRequirements(data.requirements);
                if (data.design) setDesign(data.design);
                if (data.nexusRules) setNexusRules(data.nexusRules);

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

    if (!isLoaded) return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--nexus-subtext)' }}>Loading Nexus...</div>;

    if (!hasKey) {
        return (
            <div className="auth-screen">
                <h2>Welcome to Andromeda</h2>
                <p>To use Enterprise features, please securely store your API Key.</p>
                <input type="password" id="api-key-input" placeholder="sk-proj-..." />
                <button className="auth-btn primary" onClick={() => {
                    const val = (document.getElementById('api-key-input') as HTMLInputElement).value;
                    if (val) vscode.postMessage({ type: 'saveApiKey', value: val });
                }}>Save Key to OS Vault</button>
                <button className="auth-btn secondary" onClick={() => {
                    vscode.postMessage({ type: 'saveApiKey', value: 'lm-studio' });
                }}>Use Local LLM (Skip)</button>
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
        const lastWord = words[words.length - 1];

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
            {/* 🚀 Mount the Security Overlay and pass vscode down! */}
            {!isAuthenticated && <LoginModal vscode={vscode} />}

            <div className="tiny-header" style={{ color: metaMode ? 'var(--nexus-error)' : 'var(--nexus-subtext)' }}>
                {metaMode ? '⚠️ SELF-EVOLUTION ACTIVE' : 'Andromeda'}
            </div>

            {/*  TABS HEADER */}
            <div className="tabs-header" style={{ display: 'flex', borderBottom: '1px solid var(--vscode-widget-border)', flexShrink: 0, marginTop: '5px' }}>
                <button
                    style={{ flex: 1, padding: '8px', background: activeTab === 'coder' ? 'var(--vscode-editor-inactiveSelectionBackground)' : 'transparent', border: 'none', borderBottom: activeTab === 'coder' ? '2px solid var(--vscode-button-background)' : 'none', color: activeTab === 'coder' ? 'var(--vscode-button-background)' : 'var(--vscode-foreground)', cursor: 'pointer', fontWeight: activeTab === 'coder' ? 'bold' : 'normal' }}
                    onClick={() => setActiveTab('coder')}
                >
                    Vibe
                </button>
                <button
                    style={{ flex: 1, padding: '8px', background: activeTab === 'builder' ? 'var(--vscode-editor-inactiveSelectionBackground)' : 'transparent', border: 'none', borderBottom: activeTab === 'builder' ? '2px solid var(--vscode-button-background)' : 'none', color: activeTab === 'builder' ? 'var(--vscode-button-background)' : 'var(--vscode-foreground)', cursor: 'pointer', fontWeight: activeTab === 'builder' ? 'bold' : 'normal' }}
                    onClick={() => setActiveTab('builder')}
                >
                    Spec
                </button>
                <button
                    style={{ flex: 1, padding: '8px', background: activeTab === 'rules' ? 'var(--vscode-editor-inactiveSelectionBackground)' : 'transparent', border: 'none', borderBottom: activeTab === 'rules' ? '2px solid var(--vscode-button-background)' : 'none', color: activeTab === 'rules' ? 'var(--vscode-button-background)' : 'var(--vscode-foreground)', cursor: 'pointer', fontWeight: activeTab === 'rules' ? 'bold' : 'normal' }}
                    onClick={() => setActiveTab('rules')}
                >
                    Skills
                </button>

                <button
                    style={{ flex: 1, padding: '8px', background: activeTab === 'Map' ? 'var(--vscode-editor-inactiveSelectionBackground)' : 'transparent', border: 'none', borderBottom: activeTab === 'Map' ? '2px solid var(--vscode-button-background)' : 'none', color: activeTab === 'Map' ? 'var(--vscode-button-background)' : 'var(--vscode-foreground)', cursor: 'pointer', fontWeight: activeTab === 'Map' ? 'bold' : 'normal' }}
                    onClick={() => {
                        setActiveTab('Map');

                        //  THE FIX: Only auto-fetch if we have NEVER loaded the map before!
                        // Otherwise, rely purely on the user clicking the manual Refresh button.
                        if (!graphPayload) {
                            vscode.postMessage({ type: 'requestWorkspaceGraph' });
                        }
                    }}
                    title="Visualize Workspace Context Graph"
                >
                    Map
                </button>
            </div>

            {/* ========================================================= */}
            {/* 💻 TAB 1: THE CODER (Chat & Execution)                      */}
            {/* ========================================================= */}
            <div style={{ display: activeTab === 'coder' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                <div style={{ display: 'flex', background: 'var(--vscode-editorGroupHeader-tabsBackground)', overflowX: 'auto', padding: '4px 8px 0 8px', gap: '2px', flexShrink: 0 }}>
                    {sessions.map(s => (
                        <div
                            key={s.id}
                            style={{
                                padding: '6px 12px',
                                background: s.id === activeSessionId ? 'var(--vscode-editor-background)' : 'transparent',
                                color: s.id === activeSessionId ? 'var(--vscode-tab-activeForeground)' : 'var(--vscode-tab-inactiveForeground)',
                                borderTop: s.id === activeSessionId ? '2px solid var(--vscode-tab-activeBorderTop)' : '2px solid transparent',
                                borderTopLeftRadius: '4px', borderTopRightRadius: '4px',
                                fontSize: '11px', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
                                minWidth: '100px', justifyContent: 'space-between'
                            }}
                            onClick={() => switchSession(s.id)}
                        >
                            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--vscode-terminal-ansiMagenta)' }}></div>
                                {s.name}
                            </span>
                            <span
                                style={{ opacity: 0.6, cursor: 'pointer' }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (sessions.length > 1) {
                                        const newSessions = sessions.filter(session => session.id !== s.id);
                                        setSessions(newSessions);
                                        delete sessionStoreRef.current[s.id];
                                        if (activeSessionId === s.id) {
                                            switchSession(newSessions[newSessions.length - 1].id);
                                        }
                                    }
                                }}
                            >×</span>
                        </div>
                    ))}
                    <button
                        style={{ background: 'transparent', border: 'none', color: 'var(--vscode-tab-inactiveForeground)', cursor: 'pointer', padding: '0 8px', fontSize: '14px' }}
                        onClick={() => {
                            const newId = Date.now().toString();
                            setSessions([...sessions, { id: newId, name: `Session ${sessions.length + 1}` }]);
                            switchSession(newId);
                        }}
                    >+</button>
                </div>

                <div className="chat-container" style={{ flex: 1, overflowY: 'auto' }}>
                    {messages.length === 0 && (
                        <div className="message" style={{ color: 'var(--nexus-subtext)', textAlign: 'center', marginTop: '20px' }}>
                            How can I help you build today?
                        </div>
                    )}

                    {messages.map((msg, idx) => {
                        if (msg.isCompacted) {
                            return (
                                <div key={idx} style={{
                                    margin: '16px 8px',
                                    padding: '8px 12px',
                                    backgroundColor: 'var(--vscode-badge-background)',
                                    color: 'var(--vscode-badge-foreground)',
                                    borderRadius: '6px',
                                    fontSize: '11px',
                                    border: '1px solid var(--vscode-widget-border)',
                                    cursor: 'pointer',
                                    opacity: 0.8
                                }}>
                                    <details>
                                        <summary style={{ fontWeight: 'bold', outline: 'none' }}>
                                            🗜️ Context Compacted (Old messages summarized to save tokens)
                                        </summary>
                                        <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'var(--vscode-editor-background)', borderRadius: '4px', border: '1px solid var(--vscode-widget-border)' }}>
                                            <ReactMarkdown>{msg.content || ''}</ReactMarkdown>
                                        </div>
                                    </details>
                                </div>
                            );
                        }

                        return (
                            <div key={idx} className="message">
                                <div className={`message-header ${msg.role}`}>
                                    {msg.role === 'user' ? Icons.User : Icons.Nexus}
                                    {msg.role === 'user' ? 'YOU' : 'NEXUS'}
                                </div>

                                {msg.content && (
                                    <div className="message-content markdown-body">
                                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                                    </div>
                                )}

                                {msg.role === 'user' && msg.attachments && msg.attachments.length > 0 && (
                                    <div className="message-attachments">
                                        {msg.attachments.map((att, i) => (
                                            <details key={i} className="attachment-details">
                                                <summary>📄 {att.file}</summary>
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
                                            <span>📋 Master Implementation Plan</span>
                                            <span style={{ fontSize: '11px', color: 'var(--nexus-subtext)', fontWeight: 'normal' }}>
                                                {msg.plan.implementationTasks.length} Tasks (Click to fold)
                                            </span>
                                        </summary>
                                        <div className="task-list" style={{ padding: '12px' }}>
                                            {msg.plan.implementationTasks.map((rawTask, tIdx) => {
                                                const isObj = typeof rawTask !== 'string';
                                                const taskObj = isObj ? (rawTask as ProjectTask) : null;

                                                const taskKey = taskObj ? taskObj.step : (rawTask as string);
                                                const taskTitle = taskObj ? taskObj.step : (rawTask as string);
                                                const taskFile = taskObj ? taskObj.file : "";
                                                const taskReq = taskObj ? taskObj.relatedRequirement : "";

                                                const taskPrompt = taskObj
                                                    ? `Task: ${taskObj.step}\nTarget File: ${taskObj.file}\nRelated PRD Requirement: ${taskReq}\n\nDetailed Instructions: ${taskObj.detailedInstructions}`
                                                    : (rawTask as string);

                                                const status = taskStatuses[taskKey];

                                                return (
                                                    <details
                                                        key={tIdx}
                                                        className="task-item-accordion"
                                                        //  THE UX MAGIC: Auto-open if it hasn't started or is currently running!
                                                        open={!status || status === 'reviewing' || status === 'error'}
                                                        style={{
                                                            marginBottom: '8px',
                                                            border: '1px solid var(--vscode-widget-border)',
                                                            borderRadius: '6px',
                                                            background: 'var(--vscode-editor-background)',
                                                            overflow: 'hidden'
                                                        }}
                                                    >
                                                        {/* THE HEADER ROW (Always Visible) */}
                                                        <summary style={{
                                                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                                            padding: '10px 12px', cursor: 'pointer', outline: 'none', userSelect: 'none',
                                                            background: 'var(--vscode-editorGroupHeader-tabsBackground)',
                                                            borderBottom: (!status || status === 'reviewing' || status === 'error') ? '1px solid var(--vscode-widget-border)' : 'none'
                                                        }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', fontSize: '13px', color: 'var(--vscode-foreground)' }}>
                                                                <span>{tIdx + 1}. {taskTitle}</span>
                                                            </div>

                                                            {/* Compact Status Badges for the Header */}
                                                            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                                {status === 'reviewing' && <span style={{ color: 'var(--vscode-charts-orange)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '6px' }}><span className="spin">{Icons.Loader}</span> Working...</span>}
                                                                {status === 'approved' && <span style={{ color: 'var(--vscode-testing-iconPassed)', fontSize: '11px', fontWeight: 'bold' }}>✅ Approved</span>}
                                                                {status === 'rejected' && <span style={{ color: 'var(--vscode-testing-iconFailed)', fontSize: '11px', fontWeight: 'bold' }}>❌ Rejected</span>}
                                                                {status === 'error' && <span style={{ color: 'var(--vscode-testing-iconFailed)', fontSize: '11px', fontWeight: 'bold' }}>⚠️ Error</span>}
                                                                {status === 'undone' && <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '11px' }}>⏪ Reverted</span>}
                                                            </div>
                                                        </summary>

                                                        {/* THE COLLAPSIBLE BODY (Logs, Reasoning, Actions) */}
                                                        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

                                                            {/* Context & Prompts */}
                                                            <div>
                                                                {taskObj && <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontFamily: 'monospace', marginBottom: '4px' }}>📄 {taskFile}</div>}
                                                                {taskReq && (
                                                                    <div style={{ fontSize: '10px', color: 'var(--vscode-textLink-foreground)', fontStyle: 'italic', background: 'var(--vscode-textCodeBlock-background)', padding: '2px 6px', borderRadius: '4px', display: 'inline-block' }}>
                                                                        🔗 Ref: {taskReq}
                                                                    </div>
                                                                )}

                                                                {taskObj && taskObj.detailedInstructions && (
                                                                    <details style={{ marginTop: '8px', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                                                                        <summary style={{ cursor: 'pointer', outline: 'none', userSelect: 'none', fontWeight: 'bold', opacity: 0.8 }}>View Prompt Instructions</summary>
                                                                        <div style={{ marginTop: '6px', padding: '8px', borderLeft: '2px solid var(--vscode-editorIndentGuide-activeBackground)', background: 'var(--vscode-editor-inactiveSelectionBackground)', whiteSpace: 'pre-wrap', borderRadius: '0 4px 4px 0' }}>
                                                                            {taskObj.detailedInstructions}
                                                                        </div>
                                                                    </details>
                                                                )}
                                                            </div>

                                                            {/* AI Execution Steps */}
                                                            {taskSteps[taskKey] && taskSteps[taskKey].length > 0 && (
                                                                <div className="agent-steps-container" style={{ background: 'var(--vscode-input-background)', padding: '8px', borderRadius: '6px', border: '1px solid var(--vscode-input-border)' }}>
                                                                    <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--nexus-subtext)', marginBottom: '6px', textTransform: 'uppercase' }}>Swarm Execution Logs</div>
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

                                                            {terminalStreams[taskKey] && (
                                                                <div style={{
                                                                    background: '#0d1117', // Pitch black terminal feel
                                                                    padding: '10px',
                                                                    borderRadius: '6px',
                                                                    border: '1px solid #30363d',
                                                                    marginTop: '8px',
                                                                    fontFamily: 'monospace',
                                                                    fontSize: '10.5px',
                                                                    color: '#c9d1d9',
                                                                    maxHeight: '150px',
                                                                    overflowY: 'auto',
                                                                    whiteSpace: 'pre-wrap'
                                                                }}>
                                                                    <div style={{ color: '#8b949e', marginBottom: '6px', userSelect: 'none' }}>$ terminal execution</div>
                                                                    {terminalStreams[taskKey]}
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
                                                                        <span title="Task Input Tokens">📥 {taskTokens[taskKey].prompt.toLocaleString()}</span>
                                                                        <span title="Task Output Tokens">📤 {taskTokens[taskKey].completion.toLocaleString()}</span>
                                                                    </div>
                                                                )}

                                                                <div style={{ display: 'flex', gap: '8px' }}>
                                                                    {/* 1. Approved State: Diff and Undo */}
                                                                    {status === 'approved' && taskFiles[taskKey] && (
                                                                        <>
                                                                            <button className="micro-btn" onClick={() => vscode.postMessage({ type: 'showDiff', filepath: taskFiles[taskKey] })} title="Compare Changes">⚖️ Diff</button>
                                                                            <button className="micro-btn" onClick={() => vscode.postMessage({ type: 'undoTaskEdit', task: taskKey })} title="Undo Edit">↩️ Undo</button>
                                                                        </>
                                                                    )}

                                                                    {/* 2. Rejected State: Allow Manual Feedback */}
                                                                    {status === 'rejected' && (
                                                                        <button className="micro-btn" onClick={() => vscode.postMessage({ type: 'requestRevision', task: taskKey, codingStyle: codingStyleRef.current })}>💬 Provide Feedback</button>
                                                                    )}

                                                                    {/* 3. Executable States: Empty, Rejected, or Error */}
                                                                    {(!status || status === 'rejected' || status === 'error') && (
                                                                        <>
                                                                            {/* Only show Verify if it has never been run */}
                                                                            {!status && (
                                                                                <button className="micro-btn" onClick={() => { setTaskStatuses(prev => ({ ...prev, [taskKey]: 'reviewing' })); setTaskSteps(prev => ({ ...prev, [taskKey]: [] })); setTaskReasoning(prev => ({ ...prev, [taskKey]: '' })); vscode.postMessage({ type: 'verifyTask', task: taskKey, prompt: taskPrompt }); }} title="Verify manual code">👁️ Verify</button>
                                                                            )}
                                                                            
                                                                            {/* Main Execution / Retry Button */}
                                                                            <button className="micro-btn btn-primary" style={{ background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' }} onClick={() => { setTaskStatuses(prev => ({ ...prev, [taskKey]: 'reviewing' })); setTaskSteps(prev => ({ ...prev, [taskKey]: [] })); setTaskReasoning(prev => ({ ...prev, [taskKey]: '' })); vscode.postMessage({ type: 'executeTask', task: taskKey, prompt: taskPrompt, codingStyle: codingStyleRef.current }); }} title="Auto-execute task">
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
                                <div key={key} className="message" style={{ marginBottom: '15px' }}>
                                    <div className="message-header assistant" style={{ marginBottom: '8px' }}>
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

                    {loading && !agentStatus && (
                        <div className="message">
                            <div className="message-header assistant">{Icons.Nexus} NEXUS</div>
                            <div className="message-content" style={{ display: 'flex', gap: '8px', color: 'var(--nexus-subtext)' }}>
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
                        <div className="message" style={{ margin: '10px 16px', border: '1px solid var(--nexus-warning)', borderRadius: '6px', overflow: 'hidden' }}>
                            <div style={{ background: 'rgba(204, 167, 0, 0.1)', padding: '10px', fontSize: '11px', fontWeight: 'bold', color: 'var(--nexus-warning)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                {Icons.Alert} SECURITY INTERCEPTOR: ACTION REQUIRED
                            </div>
                            <div style={{ padding: '12px', background: 'var(--nexus-card-bg)' }}>
                                <div style={{ fontSize: '12px', marginBottom: '8px' }}>{pendingCommand.message}</div>
                                <code style={{ display: 'block', padding: '8px', background: 'black', borderRadius: '4px', marginBottom: '12px', color: '#73c991' }}>
                                    $ {pendingCommand.command}
                                </code>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <button className="btn-primary" style={{ flex: 1 }} onClick={() => {
                                        // 🔥 UX FIX: Wipe all old terminal streams so the new execution starts on a clean slate!
                                        setTerminalStreams({});
                                        vscode.postMessage({ type: 'approveCommand', command: pendingCommand.command });
                                        setPendingCommand(null);
                                    }}>Allow</button>
                                    <button className="btn-secondary" style={{ flex: 1, borderColor: 'var(--nexus-error)', color: 'var(--nexus-error)' }} onClick={() => {
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
                    <div className="agent-status" style={{ flexShrink: 0 }}>
                        {!agentStatus.includes('⚠️') && !agentStatus.includes('🛑') && Icons.Loader}
                        <span style={{ marginLeft: agentStatus.includes('⚠️') ? '0' : '4px' }}>
                            {agentStatus}
                        </span>
                    </div>
                )}

                {pendingEdits && (
                    <div className="review-dock" style={{ flexShrink: 0 }}>
                        <div className="review-header">
                            <span>⚠️ Review Proposed Edits</span>
                            <span style={{ cursor: 'pointer', color: 'var(--nexus-subtext)' }} onClick={() => setPendingEdits(null)}>×</span>
                        </div>
                        <div style={{ maxHeight: '80px', overflowY: 'auto' }}>
                            {pendingEdits.map((edit, i) => (
                                <div key={i} className="review-file">
                                    <span>📄 {edit.filepath}</span>
                                    <span style={{ color: 'var(--nexus-border)' }}>({edit.action})</span>
                                </div>
                            ))}
                        </div>
                        <div className="review-actions">
                            <button className="btn-primary" onClick={() => { setLoading(true); setAgentStatus("Committing..."); vscode.postMessage({ type: 'commitAtomicEdits', edits: pendingEdits }); }}>✅ Commit All</button>
                            <button className="btn-secondary" onClick={() => setPendingEdits(null)}>Cancel</button>
                        </div>
                    </div>
                )}

                <div className="bottom-area" style={{ flexShrink: 0 }}>
                    <div className="input-wrapper" style={{ borderColor: metaMode ? 'var(--nexus-error)' : '' }}>
                        {attachedContexts.length > 0 && (
                            <div className="context-chips">
                                {attachedContexts.map((ctx, idx) => (
                                    <div key={idx} className="context-chip" title={ctx.code}>
                                        <span className="chip-icon">📄</span>
                                        <span className="chip-label">{ctx.file}</span>
                                        <span className="chip-close" onClick={() => setAttachedContexts(prev => prev.filter((_, i) => i !== idx))}>×</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {showMentionMenu && mentionResults.length > 0 && (
                            <div className="mention-menu">
                                <div className="mention-header">Attach File Context</div>
                                {mentionResults.map(res => (
                                    <div key={res} className="mention-item" onClick={() => {
                                        vscode.postMessage({ type: 'readFileContext', file: res });
                                        setShowMentionMenu(false);
                                        const words = input.split(' ');
                                        words.pop();
                                        setInput(words.join(' ') + (words.length > 0 ? ' ' : ''));
                                        document.getElementById('chat-input')?.focus();
                                    }}>
                                        📄 {res}
                                    </div>
                                ))}
                            </div>
                        )}

                        <textarea
                            id="chat-input" value={input} onChange={handleInput} onKeyDown={handleKeyDown}
                            placeholder={metaMode ? "Modify source code..." : "Ask a question or request a build..."}
                            rows={1}
                        />

                        {loading ? (
                            <button className="send-btn stop-btn" onClick={() => { setLoading(false); vscode.postMessage({ type: 'cancelTask' }); }} title="Stop Generation">■</button>
                        ) : (
                            <button className="send-btn" onClick={() => handleSubmit()} disabled={!input.trim() && attachedContexts.length === 0}>{Icons.UpArrow}</button>
                        )}
                    </div>

                    <div className="micro-toolbar">
                        <div className="toolbar-group">
                            <select className="micro-select" value={selectedModel} onChange={(e) => { setSelectedModel(e.target.value); vscode.postMessage({ type: 'setModel', value: e.target.value }); }}>
                                {availableModels.length === 0 && <option value="">Loading...</option>}
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
                                title="Auto-Generate & Run Tests for the currently open file">
                                Auto-Test
                            </button>

                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--vscode-testing-iconPassed)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.9, padding: 0 }}
                                onClick={() => vscode.postMessage({ type: 'runGlobalCompiler' })}
                                title="Run strict project-wide compilation check">
                                {Icons.Build} Compile
                            </button>
                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--vscode-foreground)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.7, padding: 0 }}
                                onClick={handleClearHistory}
                                title="Clear Chat History">
                                {Icons.Trash} Clear
                            </button>
                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-foreground)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.7, padding: 0 }}
                                onClick={() => vscode.postMessage({ type: 'refreshCodeLens' })}
                                title="Refresh UI">
                                {Icons.Refresh}
                            </button>

                            {/* 🚀 Render Logout Button */}
                            <button className="micro-btn" style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--vscode-foreground)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.7, padding: 0, marginLeft: '4px' }} onClick={() => vscode.postMessage({ type: 'logout' })} title="Log Out">
                                Logout
                            </button>

                            {/* 🚀 Render Global Tokens */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', color: 'var(--nexus-subtext)', borderLeft: '1px solid var(--vscode-widget-border)', paddingLeft: '8px', marginLeft: '4px' }}>
                                <span title="Total Input Tokens">📥 {globalTokens.prompt.toLocaleString()}</span>
                                <span title="Total Output Tokens">📤 {globalTokens.completion.toLocaleString()}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ========================================================= */}
            {/* 📋 TAB 2: THE REQUIREMENT HUB (BUILDER)                   */}
            {/* ========================================================= */}
            <div style={{ display: activeTab === 'builder' ? 'flex' : 'none', flexDirection: 'column', padding: '20px', flex: 1, overflowY: 'auto' }}>
                {(!requirements || requirements.trim() === '') && !isGeneratingReqs && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <h3 style={{ margin: 0, color: 'var(--vscode-foreground)' }}>Start a New Project</h3>
                        <p style={{ margin: 0, fontSize: '12px', color: 'var(--nexus-subtext)' }}>Describe your app idea. Attach API docs or reference files to enforce exact payloads.</p>

                        {builderContexts.length > 0 && (
                            <div className="context-chips" style={{ marginBottom: '5px' }}>
                                {builderContexts.map((ctx, idx) => (
                                    <div key={idx} className="context-chip" title={ctx.code}>
                                        <span className="chip-icon">📄</span>
                                        <span className="chip-label">{ctx.file}</span>
                                        <span className="chip-close" onClick={() => setBuilderContexts(prev => prev.filter((_, i) => i !== idx))}>×</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                            <button
                                style={{ padding: '6px 12px', background: 'var(--vscode-editor-inactiveSelectionBackground)', color: 'var(--vscode-foreground)', border: '1px solid var(--nexus-border)', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                                onClick={() => { searchTargetRef.current = 'builder'; setIsSearching(true); }}
                            >
                                {Icons.Plus} Attach Specs / API Docs
                            </button>
                        </div>

                        {isSearching && (
                            <div style={{ background: 'var(--vscode-editor-background)', border: '1px solid var(--nexus-border)', borderRadius: '6px', padding: '10px', marginBottom: '10px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                                    <span style={{ fontSize: '11px', fontWeight: 'bold' }}>Search Workspace</span>
                                    <button style={{ background: 'none', border: 'none', color: 'var(--nexus-subtext)', cursor: 'pointer' }} onClick={() => setIsSearching(false)}>✖</button>
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
                                    placeholder="Search files by name (e.g., stripe.ts)..."
                                    style={{ width: '100%', boxSizing: 'border-box', padding: '6px', marginBottom: '8px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: '4px' }}
                                />
                                <div style={{ maxHeight: '120px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                    {searchResults.map(res => (
                                        <button key={res} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--vscode-textLink-foreground)', cursor: 'pointer', padding: '4px', fontSize: '12px' }}
                                            onClick={() => vscode.postMessage({ type: 'readFileContext', file: res })}>
                                            📄 {res}
                                        </button>
                                    ))}
                                    {searchQuery.length > 2 && searchResults.length === 0 && <div style={{ fontSize: '11px', color: 'var(--nexus-subtext)' }}>No files found.</div>}
                                </div>
                            </div>
                        )}

                        <textarea
                            value={rawIdea}
                            onChange={(e) => setRawIdea(e.target.value)}
                            placeholder="e.g. Build a checkout system. Use the attached Stripe API docs for the exact JSON payloads..."
                            rows={5}
                            style={{ width: '100%', boxSizing: 'border-box', padding: '10px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: '4px', fontFamily: 'var(--vscode-editor-font-family)' }}
                        />
                        <button
                            style={{ padding: '10px', cursor: 'pointer', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}
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
                            🪄 Auto-Generate RAG-Enhanced PRD
                        </button>
                    </div>
                )}

                {(isGeneratingReqs || isGeneratingDesign) && (
                    <div className="plan-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', marginTop: '10px' }}>
                        <div className="plan-card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 15px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <div style={{ color: 'var(--vscode-button-background)' }}>{Icons.Loader}</div>
                                <span style={{ fontWeight: 'bold' }}>
                                    {isGeneratingReqs ? 'Drafting PRD...' : 'Architecting System Design...'}
                                    <span style={{ color: 'var(--nexus-subtext)', marginLeft: '8px', fontFamily: 'monospace' }}>[{formatTime(specTimer)}]</span>
                                </span>
                            </div>
                            <button
                                className="micro-btn"
                                style={{ border: '1px solid var(--nexus-error)', color: 'var(--nexus-error)', padding: '4px 8px' }}
                                onClick={() => {
                                    vscode.postMessage({ type: 'cancelTask' });
                                    setIsGeneratingReqs(false);
                                    setIsGeneratingDesign(false);
                                }}
                            >
                                🛑 Stop
                            </button>
                        </div>
                        <div style={{ padding: '15px', flex: 1, overflowY: 'auto', background: 'var(--vscode-input-background)', color: 'var(--vscode-descriptionForeground)', fontFamily: 'monospace', fontSize: '12px', borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px' }}>
                            {reqLogs.map((log, i) => {
                                let logColor = 'inherit';
                                if (log.includes('━━━')) logColor = 'var(--vscode-textLink-foreground)';
                                else if (log.includes('❌') || log.includes('Error')) logColor = 'var(--vscode-errorForeground)';
                                else if (log.includes('Domain:') || log.includes('Product Type:')) logColor = 'var(--vscode-symbolIcon-propertyForeground)';
                                return <div key={i} style={{ marginBottom: '6px', color: logColor, whiteSpace: 'pre-wrap', lineHeight: '1.4' }}>{log}</div>;
                            })}
                        </div>
                    </div>
                )}

                {(requirements && requirements.trim() !== '') && !design && !isGeneratingReqs && !isGeneratingDesign && (
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexShrink: 0 }}>
                            <span style={{ fontSize: '12px', color: '#51cf66', fontWeight: 'bold' }}>✅ Saved to nexuscode/requirements.md</span>
                            <div style={{ display: 'flex', gap: '10px' }}>
                                <button style={{ background: 'transparent', color: 'var(--vscode-textLink-foreground)', border: 'none', cursor: 'pointer', fontSize: '12px' }} onClick={() => setIsEditingReqs(!isEditingReqs)}>
                                    {isEditingReqs ? '👁️ Preview' : '✏️ Edit'}
                                </button>
                                <button style={{ background: 'transparent', color: 'var(--vscode-textLink-foreground)', border: 'none', cursor: 'pointer', fontSize: '12px' }}
                                    onClick={() => {
                                        setRequirements(''); setRawIdea(''); setReqLogs([]); setIsEditingReqs(false);
                                        vscode.postMessage({ type: 'updateRequirements', text: '' });
                                    }}>
                                    🔄 Start Over
                                </button>
                            </div>
                        </div>

                        {!isEditingReqs ? (
                            <div className="markdown-body" style={{ flex: 1, overflowY: 'auto', padding: '15px', background: 'var(--vscode-editor-background)', border: '1px solid var(--vscode-input-border)', borderRadius: '6px', marginBottom: '15px' }}>
                                <ReactMarkdown>{cleanTraceabilityTags(requirements)}</ReactMarkdown>
                            </div>
                        ) : (
                            <textarea
                                style={{ flex: 1, resize: 'none', padding: '12px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: '6px', fontFamily: 'monospace', marginBottom: '15px', lineHeight: '1.5' }}
                                value={requirements}
                                onChange={(e) => { setRequirements(e.target.value); vscode.postMessage({ type: 'updateRequirements', text: e.target.value }); }}
                            />
                        )}

                        <button
                            style={{ padding: '10px', cursor: 'pointer', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: '4px', fontWeight: 'bold', flexShrink: 0 }}
                            onClick={() => {
                                setIsGeneratingDesign(true);
                                setReqLogs([]);
                                vscode.postMessage({ type: 'generateDesign', requirements });
                            }}
                        >
                            ✅ Approve PRD & Generate Architecture Design
                        </button>
                    </div>
                )}

                {(requirements && design) && !isGeneratingDesign && (
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexShrink: 0 }}>
                            <span style={{ fontSize: '12px', color: '#51cf66', fontWeight: 'bold' }}>✅ Saved requirements.md & design.md</span>
                            <div style={{ display: 'flex', gap: '10px' }}>
                                <button style={{ background: 'transparent', color: 'var(--vscode-textLink-foreground)', border: 'none', cursor: 'pointer', fontSize: '12px' }} onClick={() => setIsEditingDesign(!isEditingDesign)}>
                                    {isEditingDesign ? '👁️ Preview' : '✏️ Edit Design'}
                                </button>
                                <button style={{ background: 'transparent', color: 'var(--vscode-textLink-foreground)', border: 'none', cursor: 'pointer', fontSize: '12px' }}
                                    onClick={() => {
                                        setRequirements(''); setDesign(''); setRawIdea(''); setReqLogs([]); setIsEditingReqs(false); setIsEditingDesign(false);
                                        vscode.postMessage({ type: 'updateRequirements', text: '' });
                                    }}>
                                    🔄 Start Over
                                </button>
                            </div>
                        </div>

                        {!isEditingDesign ? (
                            <div className="markdown-body" style={{ flex: 1, overflowY: 'auto', padding: '15px', background: 'var(--vscode-editor-background)', border: '1px solid var(--vscode-input-border)', borderRadius: '6px', marginBottom: '15px' }}>
                                <h2>1. Product Requirements</h2>
                                <ReactMarkdown>{cleanTraceabilityTags(requirements)}</ReactMarkdown>
                                <hr />
                                <h2>2. System Design</h2>
                                <ReactMarkdown>{cleanTraceabilityTags(design)}</ReactMarkdown>
                            </div>
                        ) : (
                            <textarea
                                style={{ flex: 1, resize: 'none', padding: '12px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: '6px', fontFamily: 'monospace', marginBottom: '15px', lineHeight: '1.5' }}
                                value={design}
                                onChange={(e) => { setDesign(e.target.value); vscode.postMessage({ type: 'updateDesign', text: e.target.value }); }}
                            />
                        )}

                        {isGeneratingTasks ? (
                            <div style={{ padding: '10px', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '15px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    {Icons.Loader} Drafting Master Implementation Plan... <span style={{ fontFamily: 'monospace' }}>[{formatTime(specTimer)}]</span>
                                </div>
                                <button
                                    style={{ background: 'transparent', border: '1px solid white', color: 'white', borderRadius: '4px', cursor: 'pointer', padding: '2px 8px' }}
                                    onClick={() => { vscode.postMessage({ type: 'cancelTask' }); setIsGeneratingTasks(false); }}
                                >
                                    Stop
                                </button>
                            </div>
                        ) : (
                            <div style={{ display: 'flex', gap: '10px', marginTop: '15px', flexShrink: 0 }}>
                                <button
                                    style={{ flex: 1, padding: '10px', cursor: 'pointer', background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}
                                    onClick={() => {
                                        vscode.postMessage({ type: 'updateRequirements', text: requirements });
                                        vscode.postMessage({ type: 'updateDesign', text: design });
                                        setActiveTab('coder');
                                    }}
                                >
                                    💾 Just Save
                                </button>
                                <button
                                    style={{ flex: 2, padding: '10px', cursor: 'pointer', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}
                                    onClick={() => {
                                        setIsGeneratingTasks(true);
                                        vscode.postMessage({ type: 'generateProjectTasks' });
                                    }}
                                >
                                    ⚡ Generate Interactive Task List
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* ========================================================= */}
            {/* ✨ TAB 3: AGENT SKILLS & RULES (.nexusrules)              */}
            {/* ========================================================= */}
            <div style={{ display: activeTab === 'rules' ? 'flex' : 'none', flexDirection: 'column', padding: '20px', flex: 1, overflowY: 'auto' }}>
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <h3 style={{ margin: '0 0 5px 0', color: 'var(--vscode-foreground)' }}>Agent Skills & Directives</h3>
                    <p style={{ margin: '0 0 15px 0', fontSize: '12px', color: 'var(--nexus-subtext)' }}>
                        Define custom behaviors, preferred libraries, and architectural rules. The AI will strictly follow these instructions when writing code. Saves to <code>.nexusrules</code>.
                    </p>

                    <textarea
                        value={nexusRules}
                        onChange={(e) => setNexusRules(e.target.value)}
                        placeholder="e.g., Always use Tailwind CSS. Never use class components. Prefer Axios over fetch. All functions must include JSDoc comments."
                        style={{ flex: 1, width: '100%', boxSizing: 'border-box', padding: '15px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: '6px', fontFamily: 'monospace', fontSize: '13px', lineHeight: '1.5', resize: 'none', marginBottom: '15px' }}
                    />

                    <button
                        style={{ padding: '12px', cursor: 'pointer', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: '4px', fontWeight: 'bold', flexShrink: 0 }}
                        onClick={() => vscode.postMessage({ type: 'saveNexusRules', text: nexusRules })}
                    >
                        Save Agent Skills
                    </button>
                </div>
            </div>

            {/* ========================================================= */}
            {/* 🌌 TAB 4: THE SPLIT-VIEW MATRIX (Traceability Map)        */}
            {/* ========================================================= */}
            <div style={{ display: activeTab === 'Map' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'hidden', background: '#0d1117' }}>

                {/* Header Controls with New Map Toggles */}
                <div style={{ padding: '15px', borderBottom: '1px solid #30363d', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(13, 17, 23, 0.8)', zIndex: 1000, flexShrink: 0 }}>
                    <div>
                        <h3 style={{ margin: 0, color: 'white' }}>Traceability Matrix</h3>
                        <div style={{ fontSize: '11px', color: '#8b949e', marginTop: '4px' }}>Click a 3D Node to view its structural text data.</div>
                    </div>

                    {/*  TRACEABILITY TOGGLES */}
                    <div style={{ display: 'flex', gap: '8px', background: 'rgba(0,0,0,0.3)', padding: '4px', borderRadius: '6px' }}>
                        <button
                            style={{ padding: '6px 12px', background: activeMapType === 'codeMap' ? '#007acc' : 'transparent', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', transition: '0.2s' }}
                            onClick={() => setActiveMapType('codeMap')}
                        >Code AST</button>

                        <button
                            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', background: activeMapType === 'reqMap' ? '#007acc' : 'transparent', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', transition: '0.2s' }}
                            onClick={() => setActiveMapType('reqMap')}
                        >
                            Requirements {(isGraphLoading && activeMapType === 'reqMap') && <span className="spin">{Icons.Loader}</span>}
                        </button>

                        <button
                            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', background: activeMapType === 'combinedMap' ? '#007acc' : 'transparent', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', transition: '0.2s' }}
                            onClick={() => setActiveMapType('combinedMap')}
                        >
                            Combined Traceability {(isGraphLoading && activeMapType === 'combinedMap') && <span className="spin">{Icons.Loader}</span>}
                        </button>
                    </div>

                    <div style={{ display: 'flex', gap: '8px' }}>
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
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <div style={{ color: '#58a6ff' }} className="spin">{Icons.Loader}</div>
                                    <span style={{ color: 'white', fontWeight: 'bold', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '1px' }}>AI Matrix Synthesis</span>
                                </div>
                                <div style={{ color: '#58a6ff', fontSize: '11px', fontFamily: 'monospace', opacity: 0.9, textAlign: 'center', padding: '4px 0' }}>
                                    {agentStatus || 'Vectorizing abstract requirements...'}
                                </div>
                            </div>
                        )}

                        {!graphData ? (
                            <div style={{ color: '#8b949e', position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>Scanning workspace geometry...</div>
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
                                    <strong>Matrix Computing:</strong> The graph currently shows physical files. Semantic AI links are being calculated in the background and will appear here shortly.
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
                                title="Generate Master TDD Suite (Markdown Plan + Code) in /nexuscode"
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
                                🧪 Generate Project TDD
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
                                            <div key={node.id} id={`node-card-${node.id.replace(/[^a-zA-Z0-9-]/g, '-')}`} style={{ background: 'var(--vscode-input-background)', border: '1px solid var(--vscode-input-border)', borderRadius: '6px', padding: '12px', transition: 'border-color 0.3s', boxShadow: '0 2px 8px rgba(0,0,0,0.2)' }}>

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
                                                        <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--nexus-subtext)', marginBottom: '6px' }}>🔗 CONNECTIONS</div>
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
                                                                            <span style={{ color: '#fca311', fontWeight: 'bold', fontSize: '10px', background: 'rgba(252, 163, 17, 0.1)', padding: '2px 6px', borderRadius: '4px', flexShrink: 0 }}>
                                                                                🧠 {weight} match
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
                                        <div id={safeId} key={filepath} style={{ background: 'var(--vscode-input-background)', border: '1px solid var(--vscode-input-border)', borderRadius: '6px', padding: '12px', transition: 'border-color 0.3s', boxShadow: '0 2px 8px rgba(0,0,0,0.2)' }}>

                                            {/* Beautiful Header Layout */}
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                                                {/* 🚀 THE FIX: Added flex: 1 and minWidth: 0 to force the ellipsis to trigger */}
                                                <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingRight: '10px', flex: 1, minWidth: 0 }}>
                                                    <span style={{ color: 'var(--vscode-foreground)', fontWeight: 'bold', fontSize: '13px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }} title={fileName}>
                                                        📄 {fileName}
                                                    </span>
                                                    {dirName && (
                                                        <span style={{ color: 'var(--nexus-subtext)', fontSize: '10px', marginTop: '2px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontFamily: 'monospace' }} title={dirName}>
                                                            {dirName}
                                                        </span>
                                                    )}
                                                </div>
                                                
                                                <button
                                                    style={{ background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', border: '1px solid var(--vscode-button-border, transparent)', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', flexShrink: 0 }}
                                                    title="Open File in Editor"
                                                    onClick={() => vscode.postMessage({ type: 'openFile', filepath: filepath })}>
                                                    OPEN ↗
                                                </button>
                                            </div>

                                            {/* File Attributes */}
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '11px' }}>
                                                {node.exports?.length > 0 && (
                                                    <div style={{ background: 'rgba(81, 207, 102, 0.1)', color: '#51cf66', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(81, 207, 102, 0.3)' }}>
                                                        <strong>Exports:</strong> {node.exports.join(', ')}
                                                    </div>
                                                )}
                                                {node.classes?.length > 0 && (
                                                    <div style={{ background: 'rgba(252, 163, 17, 0.1)', color: '#fca311', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(252, 163, 17, 0.3)' }}>
                                                        <strong>Classes:</strong> {node.classes.join(', ')}
                                                    </div>
                                                )}
                                                {node.functions?.length > 0 && (
                                                    <div style={{ background: 'rgba(51, 154, 240, 0.1)', color: '#339af0', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(51, 154, 240, 0.3)' }}>
                                                        <strong>Functions:</strong> {node.functions.join(', ')}
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