// webview-ui/src/App.tsx
import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import ReactMarkdown from 'react-markdown';

const vscode = (window as any).acquireVsCodeApi();
let chatTokenBuffer = "";
let lastChatUpdate = Date.now();
let reasoningTokenBuffer = "";
let lastReasoningUpdate = Date.now();

let chatTokenTimer: any = null;
let reasoningTokenTimer: any = null;

interface ProjectTask {
    step: string;
    file: string;
    detailedInstructions: string;
}

interface Message {
    role: 'user' | 'assistant';
    content?: string;
    // 🔥 Upgrade this to accept both strings AND ProjectTasks!
    plan?: { folderStructure: string[]; implementationTasks: (string | ProjectTask)[]; };
    attachments?: AttachedContext[];
}

interface AttachedContext { file: string; code: string; language: string; }

interface AtomicEdit { filepath: string; code: string; action: 'replace' | 'append' | 'inject'; target?: string; }

interface AgentStep { type: string; description: string; details?: string; }


// --- Reusable SVG Icons ---
const Icons = {
    User: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>,
    Nexus: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>,
    Play: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>,
    Check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>,
    UpArrow: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>,
    Brain: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"></path><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"></path><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"></path><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"></path><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"></path><path d="M3.477 10.896a4 4 0 0 1 .585-.396"></path><path d="M19.938 10.5a4 4 0 0 1 .585.396"></path><path d="M6 18a4 4 0 0 1-1.967-.516"></path><path d="M19.967 17.484A4 4 0 0 1 18 18"></path></svg>,
    Loader: <svg className="spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="4.93" x2="19.07" y2="7.76"></line></svg>,
    Eye: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
};

export default function App() {
    const [taskSteps, setTaskSteps] = useState<Record<string, AgentStep[]>>({});
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<Message[]>([]);
    const [hasKey, setHasKey] = useState<boolean>(true);
    const [loading, setLoading] = useState(false);
    const [agentStatus, setAgentStatus] = useState<string>('');
    const [codingStyle, setCodingStyle] = useState('precise');
    const [taskStatuses, setTaskStatuses] = useState<Record<string, string>>({});
    const [taskSummaries, setTaskSummaries] = useState<Record<string, string>>({});
    const [taskFiles, setTaskFiles] = useState<Record<string, string>>({});
    const [taskReasoning, setTaskReasoning] = useState<Record<string, string>>({});
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [selectedModel, setSelectedModel] = useState<string>('');
    const [pendingEdits, setPendingEdits] = useState<AtomicEdit[] | null>(null);
    const [metaMode, setMetaMode] = useState(false);
    const [attachedContexts, setAttachedContexts] = useState<AttachedContext[]>([]);
    const [isLoaded, setIsLoaded] = useState(false);
    const [mentionQuery, setMentionQuery] = useState('');
    const [mentionResults, setMentionResults] = useState<string[]>([]);
    const [showMentionMenu, setShowMentionMenu] = useState(false);
    const [hasApiKey, setHasApiKey] = useState(false);
    const chatEndRef = useRef<HTMLDivElement>(null);
    const [activeTab, setActiveTab] = useState<'coder' | 'requirements'>('coder');
    const [requirements, setRequirements] = useState<string>('');
    const [rawIdea, setRawIdea] = useState<string>('');
    const [isGeneratingReqs, setIsGeneratingReqs] = useState(false);
    const [reqLogs, setReqLogs] = useState<string[]>([]);
    const [isEditingReqs, setIsEditingReqs] = useState(false);


    const [design, setDesign] = useState<string>('');
    const [isGeneratingDesign, setIsGeneratingDesign] = useState(false);
    const [isEditingDesign, setIsEditingDesign] = useState(false);
    const [isGeneratingTasks, setIsGeneratingTasks] = useState(false);

    useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, agentStatus]);
    useEffect(() => { vscode.postMessage({ type: 'requestModels' }); }, []);

    useEffect(() => {
        const messageHandler = (event: MessageEvent) => {
            const data = event.data;
            if (data.type === 'tasksGenerated') {
                setIsGeneratingTasks(false);
                setActiveTab('coder');
            }

            if (data.type === 'startRevision') {
                const { task, feedback } = data;
                setTaskStatuses(prev => ({ ...prev, [task]: 'reviewing' }));
                setTaskSummaries(prev => ({ ...prev, [task]: 'Revising based on feedback...' }));
                setTaskSteps(prev => ({ ...prev, [task]: [] }));
                setTaskReasoning(prev => ({ ...prev, [task]: '' }));
                vscode.postMessage({ type: 'executeTask', task: task, codingStyle, feedback: feedback });
            }

            if (data.type === 'injectTerminalTask') {
                const terminalTask = data.task;
                setMessages(prev => [...prev,
                { role: 'user', content: terminalTask },
                { role: 'assistant', content: "I am analyzing your terminal crash right now. Hang tight..." }
                ]);
                setTaskStatuses(prev => ({ ...prev, [terminalTask]: 'reviewing' }));
                vscode.postMessage({ type: 'executeTask', task: terminalTask, codingStyle: codingStyle });
            }

            if (data.type === 'agentStep') {
                setTaskSteps(prev => ({
                    ...prev,
                    [data.task]: [...(prev[data.task] || []), { type: data.stepType, description: data.description, details: data.details }]
                }));
            }
            if (data.type === 'searchResults') {
                setMentionResults(data.results);
            }
            if (data.type === 'addContext') {
                setAttachedContexts(prev => {
                    if (prev.some(c => c.file === data.file && c.code === data.code)) return prev;
                    return [...prev, { file: data.file, code: data.code, language: data.language }];
                });
                setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
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
                    codingStyle: 'precise'
                });
            }
            if (data.type === 'initState') {
                setMessages(data.messages || []);
                setHasKey(data.hasKey);
                if (data.taskStatuses) setTaskStatuses(data.taskStatuses);
                if (data.taskSummaries) setTaskSummaries(data.taskSummaries);
                if (data.taskFiles) setTaskFiles(data.taskFiles);
                setIsLoaded(true);
                if (data.requirements) setRequirements(data.requirements);
                if (data.design) setDesign(data.design);

                if (data.tasks && data.messages.length === 0) {
                    setMessages([{
                        role: 'assistant',
                        content: "Welcome back! I found your existing master implementation plan. You can execute tasks autonomously, or code them yourself and ask me to verify them.",
                        plan: data.tasks
                    }]);
                }
            }
            if (data.type === 'requirementsGenerated') {
                setRequirements(data.text);
                setIsGeneratingReqs(false);
            }
            if (data.type === 'designGenerated') {
                setDesign(data.text);
                setIsGeneratingDesign(false);
            }
            if (data.type === 'reqStep') {
                setReqLogs(prev => [...prev, data.message]);
            }
            if (data.type === 'requirementsGenerated') {
                setRequirements(data.text);
                setIsGeneratingReqs(false);
            }
            if (data.type === 'updateModelsList') {
                setAvailableModels(data.models);
                if (data.currentModel && data.models.includes(data.currentModel)) setSelectedModel(data.currentModel);
                else if (data.models.length > 0) setSelectedModel(data.models[0]);
            }
            if (data.type === 'structureResponse') { setMessages(prev => [...prev, { role: 'assistant', plan: data.value }]); setLoading(false); }
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
                if (!reasoningTokenTimer) {
                    reasoningTokenTimer = setTimeout(() => {
                        const flush = reasoningTokenBuffer;
                        reasoningTokenBuffer = "";
                        reasoningTokenTimer = null;
                        setTaskReasoning(prev => ({
                            ...prev, [data.task]: (prev[data.task] || '') + flush
                        }));
                    }, 50);
                }
            }

            if (data.type === 'startChatStream') {
                setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
                setLoading(false);
            }
            if (data.type === 'chatToken') {
                chatTokenBuffer += data.token;
                if (!chatTokenTimer) {
                    chatTokenTimer = setTimeout(() => {
                        const flush = chatTokenBuffer;
                        chatTokenBuffer = "";
                        chatTokenTimer = null;
                        setMessages(prev => {
                            const newMessages = [...prev];
                            const lastIdx = newMessages.length - 1;
                            if (newMessages[lastIdx] && newMessages[lastIdx].role === 'assistant') {
                                newMessages[lastIdx].content += flush;
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
    }, []);

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

    if (!hasKey) {
        return (
            <div className="auth-screen">
                <h2>🤖 Welcome to NexusCode</h2>
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
            codingStyle
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

    return (
        <div className="app-wrapper" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
            <div className="tiny-header" style={{ color: metaMode ? 'var(--nexus-error)' : 'var(--nexus-subtext)', flexShrink: 0 }}>
                {metaMode ? '⚠️ SELF-EVOLUTION ACTIVE' : 'NexusCode v0.2'}
            </div>

            {/* 🔥 TABS HEADER */}
            <div className="tabs-header" style={{ display: 'flex', borderBottom: '1px solid var(--vscode-widget-border)', flexShrink: 0, marginTop: '5px' }}>
                <button
                    style={{ flex: 1, padding: '8px', background: activeTab === 'coder' ? 'var(--vscode-editor-inactiveSelectionBackground)' : 'transparent', border: 'none', borderBottom: activeTab === 'coder' ? '2px solid var(--vscode-button-background)' : 'none', color: activeTab === 'coder' ? 'var(--vscode-button-background)' : 'var(--vscode-foreground)', cursor: 'pointer', fontWeight: activeTab === 'coder' ? 'bold' : 'normal' }}
                    onClick={() => setActiveTab('coder')}
                >
                    Vibe
                </button>
                <button
                    style={{ flex: 1, padding: '8px', background: activeTab === 'requirements' ? 'var(--vscode-editor-inactiveSelectionBackground)' : 'transparent', border: 'none', borderBottom: activeTab === 'requirements' ? '2px solid var(--vscode-button-background)' : 'none', color: activeTab === 'requirements' ? 'var(--vscode-button-background)' : 'var(--vscode-foreground)', cursor: 'pointer', fontWeight: activeTab === 'requirements' ? 'bold' : 'normal' }}
                    onClick={() => setActiveTab('requirements')}
                >
                    Spec
                </button>
            </div>

            {/* ========================================================= */}
            {/* 💻 TAB 1: THE CODER (Chat & Execution)                      */}
            {/* ========================================================= */}
            <div style={{ display: activeTab === 'coder' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>

                <div className="chat-container" style={{ flex: 1, overflowY: 'auto' }}>
                    {messages.length === 0 && (
                        <div className="message" style={{ color: 'var(--nexus-subtext)', textAlign: 'center', marginTop: '20px' }}>
                            How can I help you build today?
                        </div>
                    )}

                    {messages.map((msg, idx) => (
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
                                <div className="plan-card">
                                    <div className="plan-card-header">
                                        <span>Implementation Plan</span>
                                    </div>
                                    <div className="task-list">
                                        {msg.plan.implementationTasks.map((rawTask, tIdx) => {
                                            // 🔥 THE FIX: Extract the Object properly so React State doesn't break!
                                            const isObj = typeof rawTask !== 'string';
                                            const taskKey = isObj ? (rawTask as any).step : rawTask;
                                            const taskTitle = isObj ? (rawTask as any).step : rawTask;
                                            const taskFile = isObj ? (rawTask as any).file : "";
                                            // 🔥 NEW: Extract the requirement
                                            const taskReq = isObj ? (rawTask as any).relatedRequirement : "";

                                            // 🔥 Inject it into the Prompt so the LLM checks it while coding!
                                            const taskPrompt = isObj
                                                ? `Task: ${(rawTask as any).step}\nTarget File: ${(rawTask as any).file}\nRelated PRD Requirement: ${taskReq}\n\nDetailed Instructions: ${(rawTask as any).detailedInstructions}`
                                                : rawTask;

                                            const status = taskStatuses[taskKey];

                                            return (
                                                <div key={tIdx} className="task-item" style={{ flexDirection: 'column' }}>
                                                    <div style={{ display: 'flex', width: '100%', gap: '10px' }}>
                                                        <div className="task-desc">
                                                            <div style={{ fontWeight: 'bold' }}>{taskTitle}</div>
                                                            {isObj && <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginTop: '2px' }}>📄 {taskFile}</div>}
                                                            {taskSummaries[taskKey] && <div className="task-summary" style={{ marginTop: '4px' }}>{taskSummaries[taskKey]}</div>}
                                                        </div>
                                                        <div className="task-status">
                                                            {status === 'reviewing' && <span className="status-pending">⏳ Reviewing</span>}
                                                            {status === 'approved' && <span className="status-approved">✅ Approved</span>}
                                                            {status === 'rejected' && (
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                                    <span className="status-error">❌ Rejected</span>
                                                                    <button className="micro-btn" style={{ border: '1px solid var(--nexus-border)', padding: '2px 6px' }}
                                                                        onClick={() => vscode.postMessage({ type: 'requestRevision', task: taskKey, codingStyle })}>
                                                                        💬 Revise
                                                                    </button>
                                                                </div>
                                                            )}
                                                            {status === 'error' && (
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                                    <span className="status-error">⚠️ Error</span>
                                                                    <button className="micro-btn" style={{ border: '1px solid var(--nexus-error)', color: 'var(--nexus-error)', padding: '2px 6px' }}
                                                                        onClick={() => {
                                                                            setTaskStatuses(prev => ({ ...prev, [taskKey]: 'reviewing' }));
                                                                            setTaskSteps(prev => ({ ...prev, [taskKey]: [] }));
                                                                            vscode.postMessage({ type: 'executeTask', task: taskKey, prompt: taskPrompt, codingStyle });
                                                                        }}>
                                                                        🔄 Retry
                                                                    </button>
                                                                </div>
                                                            )}

                                                            {(status === 'reviewing' || status === 'approved') && taskFiles[taskKey] && (
                                                                <button className="micro-btn" style={{ marginLeft: '8px', padding: '2px 6px', border: '1px solid var(--nexus-border)' }}
                                                                    onClick={() => vscode.postMessage({ type: 'showDiff', filepath: taskFiles[taskKey] })}>
                                                                    🔍 View Diff
                                                                </button>
                                                            )}

                                                            {!status && (
                                                                <div style={{ display: 'flex', gap: '12px' }}>
                                                                    <button style={{ background: 'transparent', border: 'none', color: 'var(--nexus-subtext)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
                                                                        title="Verify code I wrote manually"
                                                                        onClick={() => {
                                                                            setTaskStatuses(prev => ({ ...prev, [taskKey]: 'reviewing' }));
                                                                            setTaskSteps(prev => ({ ...prev, [taskKey]: [] }));
                                                                            setTaskReasoning(prev => ({ ...prev, [taskKey]: '' }));
                                                                            vscode.postMessage({ type: 'verifyTask', task: taskKey, prompt: taskPrompt });
                                                                        }}>
                                                                        {Icons.Eye}
                                                                    </button>

                                                                    <button style={{ background: 'transparent', border: 'none', color: 'var(--vscode-button-background)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
                                                                        title="Let AI execute this task autonomously"
                                                                        onClick={() => {
                                                                            setTaskStatuses(prev => ({ ...prev, [taskKey]: 'reviewing' }));
                                                                            setTaskSteps(prev => ({ ...prev, [taskKey]: [] }));
                                                                            setTaskReasoning(prev => ({ ...prev, [taskKey]: '' }));
                                                                            vscode.postMessage({ type: 'executeTask', task: taskKey, prompt: taskPrompt, codingStyle });
                                                                        }}>
                                                                        {Icons.Play}
                                                                    </button>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* 🔥 THE FIX: Render Steps and Reasoning using taskKey! */}
                                                    {taskSteps[taskKey] && taskSteps[taskKey].length > 0 && (
                                                        <div className="agent-steps-container">
                                                            {taskSteps[taskKey].map((step, sIdx) => (
                                                                <div key={sIdx} className="agent-step-card">
                                                                    <div className="agent-step-header">
                                                                        <span className="step-icon">
                                                                            {step.type === 'search' && '🔍'}
                                                                            {step.type === 'read' && '👁️'}
                                                                            {step.type === 'analyze' && '</>'}
                                                                            {step.type === 'error' && '⚠️'}
                                                                            {step.type === 'heal' && '🏥'}
                                                                            {step.type === 'success' && '✅'}
                                                                        </span>
                                                                        <span className="step-desc">{step.description}</span>
                                                                    </div>
                                                                    {step.details && (
                                                                        <div className="agent-step-details">
                                                                            <span className="detail-pill">{step.details}</span>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}

                                                    {taskReasoning[taskKey] && (
                                                        <div className="reasoning-container">
                                                            <details open>
                                                                <summary className="reasoning-summary">
                                                                    {Icons.Brain} Reasoning...
                                                                </summary>
                                                                <div className="reasoning-content">
                                                                    {taskReasoning[taskKey]}
                                                                </div>
                                                            </details>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}

                    {loading && !agentStatus && (
                        <div className="message">
                            <div className="message-header assistant">{Icons.Nexus} NEXUS</div>
                            <div className="message-content" style={{ display: 'flex', gap: '8px', color: 'var(--nexus-subtext)' }}>
                                {Icons.Loader} Thinking...
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
                        </div>
                        <div className="toolbar-group">
                            <button className="micro-btn" onClick={() => {
                                setMessages([]);
                                setTaskStatuses({});
                                setTaskSummaries({});
                                setTaskFiles({});
                                setTaskReasoning({});
                                vscode.postMessage({ type: 'clearHistory' });
                            }} title="Clear Chat History">🗑️ Clear</button>
                            <button className="micro-btn" onClick={() => vscode.postMessage({ type: 'refreshCodeLens' })} title="Force VS Code to redraw Accept/Reject buttons">🔄 Refresh Lens</button>
                        </div>
                    </div>
                </div>

            </div>

            {/* ========================================================= */}
            {/* 📋 TAB 2: THE REQUIREMENT HUB                             */}
            {/* ========================================================= */}
            <div style={{ display: activeTab === 'requirements' ? 'flex' : 'none', flexDirection: 'column', padding: '20px', flex: 1, overflowY: 'auto' }}>

                {/* STATE 1: Input Form */}
                {(!requirements || requirements.trim() === '') && !isGeneratingReqs && (
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <p style={{ fontSize: '13px', color: 'var(--vscode-descriptionForeground)', marginBottom: '15px' }}>
                            Describe your app in a few words. Nexus will analyze the domain and generate a PRD.
                        </p>
                        <textarea
                            style={{ flex: 1, maxHeight: '120px', resize: 'none', padding: '12px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: '6px', fontFamily: 'inherit', marginBottom: '15px' }}
                            placeholder="e.g., 'generate me with a Trip.com website'"
                            value={rawIdea}
                            onChange={(e) => setRawIdea(e.target.value)}
                        />
                        <button
                            style={{ padding: '10px', cursor: 'pointer', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}
                            onClick={() => {
                                if (!rawIdea.trim()) return;
                                setIsGeneratingReqs(true);
                                setReqLogs([]);
                                vscode.postMessage({ type: 'generateRequirements', text: rawIdea });
                            }}
                        >
                            🪄 Auto-Generate PRD
                        </button>
                    </div>
                )}

                {/* STATE 2: Loading Stream (PRD or Design) */}
                {(isGeneratingReqs || isGeneratingDesign) && (
                    <div className="plan-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', marginTop: '10px' }}>
                        <div className="plan-card-header" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 15px' }}>
                            <div style={{ color: 'var(--vscode-button-background)' }}>{Icons.Loader}</div>
                            <span style={{ fontWeight: 'bold' }}>{isGeneratingReqs ? 'Drafting PRD...' : 'Architecting System Design...'}</span>
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

                {/* STATE 3: PRD Completed, Pending Design Approval */}
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
                                <ReactMarkdown>{requirements}</ReactMarkdown>
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

                {/* STATE 4: Full Stack (PRD + Design Completed) */}
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
                                <ReactMarkdown>{requirements}</ReactMarkdown>
                                <hr />
                                <h2>2. System Design</h2>
                                <ReactMarkdown>{design}</ReactMarkdown>
                            </div>
                        ) : (
                            <textarea
                                style={{ flex: 1, resize: 'none', padding: '12px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: '6px', fontFamily: 'monospace', marginBottom: '15px', lineHeight: '1.5' }}
                                value={design}
                                onChange={(e) => { setDesign(e.target.value); vscode.postMessage({ type: 'updateDesign', text: e.target.value }); }}
                            />
                        )}

                        {isGeneratingTasks ? (
                            <div style={{ padding: '10px', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', borderRadius: '4px', textAlign: 'center', marginTop: '15px' }}>
                                {Icons.Loader} Drafting Master Implementation Plan...
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
        </div>
    );
}