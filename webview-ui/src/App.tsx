// webview-ui/src/App.tsx
import React, { useState, useEffect, useRef } from 'react';
import './App.css';

const vscode = (window as any).acquireVsCodeApi();

interface Message {
    role: 'user' | 'assistant';
    content?: string;
    plan?: { folderStructure: string[]; implementationTasks: string[]; };
}

interface AtomicEdit { filepath: string; code: string; action: 'replace' | 'append' | 'inject'; target?: string; }

// --- Reusable SVG Icons ---
const Icons = {
    User: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>,
    Nexus: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>,
    Play: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>,
    Check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>,
    UpArrow: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>,
    Loader: <svg className="spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="4.93" x2="19.07" y2="7.76"></line></svg>
};

export default function App() {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(false);
    const [agentStatus, setAgentStatus] = useState<string>('');
    const [codingStyle, setCodingStyle] = useState('precise');
    const [taskStatuses, setTaskStatuses] = useState<Record<string, string>>({});
    const [taskSummaries, setTaskSummaries] = useState<Record<string, string>>({});
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [selectedModel, setSelectedModel] = useState<string>('');
    const [pendingEdits, setPendingEdits] = useState<AtomicEdit[] | null>(null);
    const [metaMode, setMetaMode] = useState(false);

    const chatEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, agentStatus]);
    useEffect(() => { vscode.postMessage({ type: 'requestModels' }); }, []);

    useEffect(() => {
        const messageHandler = (event: MessageEvent) => {
            const data = event.data;
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
                if (data.status === 'error') setLoading(false);
            }
            if (data.type === 'metaModeChanged') setMetaMode(data.value);
            if (data.type === 'requestReview') setInput(`Please review this code:\n\n\`\`\`\n${data.code}\n\`\`\``);
        };
        window.addEventListener('message', messageHandler);
        return () => window.removeEventListener('message', messageHandler);
    }, []);

    const handleSubmit = () => {
        if (!input.trim() || loading) return;
        setMessages(prev => [...prev, { role: 'user', content: input }]);
        setLoading(true);
        vscode.postMessage({ type: 'generateStructure', value: input, codingStyle });
        setInput('');
        const textarea = document.getElementById('chat-input');
        if (textarea) textarea.style.height = 'auto';
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
    };

    return (
        <div className="app-wrapper">
            <div className="tiny-header" style={{ color: metaMode ? 'var(--nexus-error)' : 'var(--nexus-subtext)' }}>
                {metaMode ? '⚠️ SELF-EVOLUTION ACTIVE' : '🤖 NexusCode v0.2'}
            </div>

            <div className="chat-container">
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
                        
                        {msg.content && <div className="message-content">{msg.content}</div>}
                        
                        {msg.plan && (
                            <div className="plan-card">
                                <div className="plan-card-header">
                                    <span>Implementation Plan</span>
                                    <button className="btn-execute-all" onClick={() => { setLoading(true); vscode.postMessage({ type: 'executeAllTasks', tasks: msg.plan!.implementationTasks, codingStyle }); }}>
                                        {Icons.Play} Execute All
                                    </button>
                                </div>
                                <div className="task-list">
                                    {msg.plan.implementationTasks.map((task, tIdx) => {
                                        const status = taskStatuses[task];
                                        return (
                                            <div key={tIdx} className="task-item">
                                                <div className="task-desc">
                                                    <div>{task}</div>
                                                    {taskSummaries[task] && <div className="task-summary">{taskSummaries[task]}</div>}
                                                </div>
                                                <div className="task-status">
                                                    {status === 'reviewing' && <span className="status-pending">⏳ Reviewing</span>}
                                                    {status === 'approved' && <span className="status-approved">✅ Approved</span>}
                                                    {status === 'rejected' && <span className="status-error">❌ Rejected</span>}
                                                    {status === 'error' && <span className="status-error">⚠️ Error</span>}
                                                    {!status && (
                                                        <button style={{ background:'transparent', border:'none', color:'var(--nexus-subtext)', cursor:'pointer' }} 
                                                                onClick={() => { setTaskStatuses(prev => ({ ...prev, [task]: 'reviewing' })); vscode.postMessage({ type: 'executeTask', task: task, codingStyle }); }}>
                                                            {Icons.Play}
                                                        </button>
                                                    )}
                                                </div>
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

            {/* STATUS CHIP */}
            {agentStatus && (
                <div className="agent-status">
                    {Icons.Loader} {agentStatus}
                </div>
            )}

            {/* DOCKED REVIEW SHEET */}
            {pendingEdits && (
                <div className="review-dock">
                    <div className="review-header">
                        <span>⚠️ Review Proposed Edits</span>
                        <span style={{ cursor:'pointer', color:'var(--nexus-subtext)' }} onClick={() => setPendingEdits(null)}>×</span>
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

            {/* INPUT & TOOLBAR */}
            <div className="bottom-area">
                <div className="input-wrapper" style={{ borderColor: metaMode ? 'var(--nexus-error)' : '' }}>
                    <textarea 
                        id="chat-input" value={input} onChange={handleInput} onKeyDown={handleKeyDown} 
                        placeholder={metaMode ? "Ask Nexus to modify its own source code..." : "Ask Nexus to build, refactor, or explain code..."} 
                        rows={1} 
                    />
                    <button className="send-btn" onClick={handleSubmit} disabled={loading || !input.trim()}>{Icons.UpArrow}</button>
                </div>

                <div className="micro-toolbar">
                    <div className="toolbar-group">
                        <select className="micro-select" value={selectedModel} onChange={(e) => { setSelectedModel(e.target.value); vscode.postMessage({ type: 'setModel', value: e.target.value }); }}>
                            {availableModels.length === 0 && <option value="">Loading...</option>}
                            {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <select className="micro-select" value={codingStyle} onChange={(e) => setCodingStyle(e.target.value)}>
                            <option value="precise">🎯 Precise</option>
                            <option value="commented">📝 Commented</option>
                        </select>
                    </div>
                    <div className="toolbar-group">
                        <button className="micro-btn" onClick={() => vscode.postMessage({ type: 'generateAndRunTests' })} title="Generate tests and Auto-Heal">🏥 Heal</button>
                        <button className={`micro-btn ${metaMode ? 'meta-active' : ''}`} onClick={() => { const val = !metaMode; setMetaMode(val); vscode.postMessage({ type: 'toggleMetaMode', value: val }); }} title="Modify extension source code">
                            🧬 Evolve
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}