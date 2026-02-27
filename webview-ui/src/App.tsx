import React, { useState, useEffect, useRef } from 'react';
import './App.css';

const vscode = (window as any).acquireVsCodeApi();

interface Message {
    role: 'user' | 'assistant';
    content?: string;
    plan?: {
        folderStructure: string[];
        implementationTasks: string[];
    };
    status?: 'pending' | 'approved' | 'rejected' | 'error';
}

// NEW: Interface for Atomic Edits
interface AtomicEdit {
    filepath: string;
    code: string;
    action: 'replace' | 'append' | 'inject';
    target?: string;
}

export default function App() {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(false);

    // Agent State
    const [agentStatus, setAgentStatus] = useState<string>('');
    const [codingStyle, setCodingStyle] = useState('precise');
    const [taskStatuses, setTaskStatuses] = useState<Record<string, string>>({});
    const [taskSummaries, setTaskSummaries] = useState<Record<string, string>>({});
    
    // NEW: Review & Meta-Mode State
    const [pendingEdits, setPendingEdits] = useState<AtomicEdit[] | null>(null);
    const [metaMode, setMetaMode] = useState(false);

    const chatEndRef = useRef<HTMLDivElement>(null);

    // --- Message Handling ---
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, agentStatus]);

    useEffect(() => {
        const messageHandler = (event: MessageEvent) => {
            const data = event.data;

            // Structure Response
            if (data.type === 'structureResponse') {
                setMessages((prev) => [...prev, { role: 'assistant', plan: data.value }]);
                setLoading(false);
            }

            // Status Update (Background Agent)
            if (data.type === 'statusUpdate') {
                setAgentStatus(data.message);
            }

            // NEW: Review Edits Trigger
            if (data.type === 'reviewEdits') {
                setPendingEdits(data.edits);
                setLoading(false);
            }

            // All Tasks Completed
            if (data.type === 'allTasksCompleted') {
                setPendingEdits(null);
                setMessages((prev) => [...prev, { 
                    role: 'assistant', 
                    content: "✅ Atomic transaction committed successfully." 
                }]);
                setAgentStatus('');
            }

            // Task Completion Update
            if (data.type === 'taskCompleted' || data.type === 'taskStatusUpdate') {
                setTaskStatuses(prev => ({ ...prev, [data.task]: data.status }));
                if (data.summary) {
                    setTaskSummaries(prev => ({ ...prev, [data.task]: data.summary }));
                }
                if (data.status === 'error') setLoading(false);
            }

            // NEW: Meta-Mode Confirmation from Backend
            if (data.type === 'metaModeChanged') {
                setMetaMode(data.value);
            }

            // Auto-Heal / Error Handling
            if (data.type === 'terminalError') {
                const errorPrompt = `I ran the command '${data.command}' and got this error:\n\n\`\`\`\n${data.error}\n\`\`\`\n\nPlease fix the code to resolve this error.`;
                setMessages((prev) => [...prev, { role: 'user', content: errorPrompt }]);
                setLoading(true);
                vscode.postMessage({ type: 'generateStructure', value: errorPrompt });
            }

            // Review Request
            if (data.type === 'requestReview') {
                setInput(`Please review this code:\n\n\`\`\`\n${data.code}\n\`\`\``);
            }
        };
        window.addEventListener('message', messageHandler);
        return () => window.removeEventListener('message', messageHandler);
    }, []);

    // --- Handlers ---
    const handleSubmit = () => {
        if (!input.trim() || loading) return;

        setMessages((prev) => [...prev, { role: 'user', content: input }]);
        setLoading(true);

        vscode.postMessage({ 
            type: 'generateStructure', 
            value: input,
            codingStyle: codingStyle 
        });

        setInput('');
        const textarea = document.getElementById('chat-input');
        if (textarea) textarea.style.height = 'auto';
    };

    const handleExecuteTask = (task: string, availableFiles?: string[]) => {
        setTaskStatuses(prev => ({ ...prev, [task]: 'reviewing' }));
        vscode.postMessage({
            type: 'executeTask',
            task: task,
            availableFiles: availableFiles,
            codingStyle: codingStyle,
            history: messages
        });
    };

    const handleExecuteAll = (tasks: string[]) => {
        setLoading(true);
        vscode.postMessage({
            type: 'executeAllTasks',
            tasks: tasks,
            codingStyle: codingStyle
        });
    };

    const handleCommit = () => {
        setLoading(true);
        setAgentStatus("Committing changes...");
        vscode.postMessage({
            type: 'commitAtomicEdits',
            edits: pendingEdits
        });
    };

    // NEW: Toggle Meta-Mode Handler
    const handleToggleMetaMode = () => {
        const newValue = !metaMode;
        setMetaMode(newValue);
        vscode.postMessage({ type: 'toggleMetaMode', value: newValue });
    };

    const handleGenerateTests = () => {
        vscode.postMessage({ type: 'generateAndRunTests' });
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <div className="app-wrapper" style={{ borderTop: metaMode ? '3px solid #ff4d4d' : 'none' }}>
            <div className="tiny-header">
                <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                    <span>Nexuscoder</span>
                    <span className="version">v0.2</span>
                    {/* Visual Indicator for Meta Mode */}
                    {metaMode && <span style={{color: '#ff4d4d', fontSize:'10px', fontWeight: 'bold'}}>SELF-EVOLUTION ACTIVE</span>}
                </div>
            </div>

            <div className="chat-container">
                {messages.length === 0 && (
                    <div className="empty-state">
                        <h2>{metaMode ? "Ready to Evolve." : "How can I help you build today?"}</h2>
                        <p>{metaMode ? "Warning: Changes will affect the extension itself." : "Ask me to generate code, plans, structures..."}</p>
                    </div>
                )}

                {messages.map((msg, idx) => (
                    <div key={idx} className={`message ${msg.role}`}>
                        {msg.role === 'user' && <div className="user-bubble">{msg.content}</div>}

                        {msg.role === 'assistant' && (
                            <>
                                {msg.content && <div style={{ marginBottom: '10px' }}>{msg.content}</div>}

                                {msg.plan && (
                                    <div className="plan-card">
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                            <h3 style={{ margin: '0', fontSize: '14px', color: 'var(--text)', fontWeight: 600 }}>Implementation Plan</h3>
                                            <button
                                                onClick={() => handleExecuteAll(msg.plan!.implementationTasks)}
                                                style={{
                                                    background: 'var(--purple)', color: 'white', border: 'none',
                                                    padding: '4px 10px', borderRadius: '4px', fontSize: '11px',
                                                    cursor: 'pointer', fontWeight: 600
                                                }}
                                            >
                                                ▶ Execute All
                                            </button>
                                        </div>
                                        {/* File Badges */}
                                        <div style={{ marginBottom: '20px' }}>
                                            <div style={{ fontSize: '12px', color: 'var(--subtext)', marginBottom: '8px' }}>Created Files:</div>
                                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                                {msg.plan.folderStructure.map((file, fIdx) => (
                                                    <div key={fIdx} style={{
                                                        display: 'flex', alignItems: 'center', gap: '6px',
                                                        background: 'rgba(0, 0, 0, 0.2)', border: '1px solid var(--border)',
                                                        padding: '4px 10px', borderRadius: '6px', fontSize: '12px',
                                                        fontFamily: 'var(--vscode-editor-font-family)'
                                                    }}>
                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                                                        <span style={{ color: 'var(--text)' }}>{file}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Task List */}
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                            {msg.plan.implementationTasks.map((task, tIdx) => {
                                                const status = taskStatuses[task];
                                                const summary = taskSummaries[task];

                                                return (
                                                    <div key={tIdx} style={{
                                                        display: 'flex', flexDirection: 'column', gap: '4px',
                                                        background: 'rgba(0,0,0,0.15)', padding: '8px 10px',
                                                        borderRadius: '6px', border: '1px solid var(--border)',
                                                        width: '100%', boxSizing: 'border-box'
                                                    }}>
                                                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', width: '100%' }}>
                                                            <div style={{ color: 'var(--subtext)', fontSize: '10px', background: 'rgba(255,255,255,0.05)', width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', flexShrink: 0, marginTop: '1px' }}>{tIdx + 1}</div>
                                                            <div style={{ flex: 1, fontSize: '12px', lineHeight: '1.3', color: 'var(--text)', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{task}</div>
                                                            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                                                                {status === 'reviewing' && <span className="status-reviewing" style={{ fontSize: '11px', color: '#ffb000', fontWeight: 600 }}>⏳ Reviewing</span>}
                                                                {status === 'approved' && <span style={{ fontSize: '11px', color: '#4CAF50', fontWeight: 600 }}>✅ Approved</span>}
                                                                {status === 'rejected' && <span style={{ fontSize: '11px', color: '#f44336', fontWeight: 600 }}>❌ Rejected</span>}
                                                                {status === 'error' && <span style={{ fontSize: '11px', color: '#f44336', fontWeight: 600 }}>⚠️ Error</span>}
                                                                {!status && (
                                                                    <button
                                                                        title="Run this step"
                                                                        style={{ background: 'transparent', color: 'var(--subtext)', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', transition: 'all 0.2s ease' }}
                                                                        onClick={() => handleExecuteTask(task, msg.plan?.folderStructure)}
                                                                    >
                                                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                        {summary && (
                                                            <div style={{ marginLeft: '28px', fontSize: '11px', color: status === 'approved' ? '#4CAF50' : 'var(--subtext)', fontStyle: 'italic', marginTop: '2px' }}>{summary}</div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                ))}

                {/* NEW: Review Edits Overlay */}
                {pendingEdits && (
                    <div className="review-overlay" style={{
                        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                        background: 'var(--bg)', zIndex: 100, padding: '20px',
                        display: 'flex', flexDirection: 'column'
                    }}>
                        <h3>Review Proposed Edits</h3>
                        <p style={{ fontSize: '12px', color: 'var(--subtext)' }}>NexusCode has drafted changes for {pendingEdits.length} files.</p>
                        <div style={{ flex: 1, overflowY: 'auto', marginBottom: '20px' }}>
                            {pendingEdits.map((edit, i) => (
                                <div key={i} style={{ border: '1px solid var(--border)', padding: '8px', marginBottom: '8px', borderRadius: '4px' }}>
                                    <div style={{ fontSize: '11px', fontWeight: 'bold' }}>{edit.filepath}</div>
                                    <div style={{ fontSize: '10px', color: 'var(--purple)' }}>Action: {edit.action}</div>
                                    {edit.target && <div style={{ fontSize: '10px', color: 'var(--subtext)' }}>Target: {edit.target}</div>}
                                </div>
                            ))}
                        </div>
                        <div style={{ display: 'flex', gap: '10px' }}>
                            <button className="submit-btn" style={{ flex: 1, borderRadius: '8px' }} onClick={handleCommit}>Commit All Changes</button>
                            <button className="submit-btn" style={{ flex: 1, borderRadius: '8px', background: 'transparent', border: '1px solid var(--border)' }} onClick={() => setPendingEdits(null)}>Cancel</button>
                        </div>
                    </div>
                )}

                {loading && !pendingEdits && (
                    <div className="message assistant">
                        <div className="user-bubble" style={{ background: 'var(--input-bg)', color: 'var(--text)' }}>
                            <span className="spinner">⏳</span> {agentStatus || "Thinking..."}
                        </div>
                    </div>
                )}
                <div ref={chatEndRef} />
            </div>

            <div className="input-container">
                {agentStatus && (
                    <div style={{
                        padding: '8px 12px', background: 'rgba(139, 92, 246, 0.1)', border: '1px solid var(--purple)',
                        borderRadius: '8px', fontSize: '12px', color: 'var(--purple)', display: 'flex', alignItems: 'center',
                        gap: '8px', marginBottom: '10px'
                    }}>
                        <span className="spinner">⏳</span> {agentStatus}
                    </div>
                )}

                <div className="input-box" style={{ borderColor: metaMode ? '#ff4d4d' : 'var(--border)' }}>
                    <textarea
                        id="chat-input"
                        value={input}
                        onChange={handleInput}
                        onKeyDown={handleKeyDown}
                        placeholder={metaMode ? "Ask Nexus to modify itself..." : "Ask anything..."}
                        rows={1}
                    />
                    <button className="submit-btn" onClick={handleSubmit} disabled={loading || !input.trim()}>↑</button>
                </div>

                <div className="input-hint" style={{ display: 'flex', justifyContent: 'center', gap: '10px', alignItems: 'center', marginTop: '12px' }}>
                    <select
                        value={codingStyle}
                        onChange={(e) => setCodingStyle(e.target.value)}
                        style={{
                            background: 'rgba(255, 255, 255, 0.05)', color: 'var(--subtext)', border: '1px solid var(--border)',
                            borderRadius: '4px', padding: '4px 8px', fontSize: '11px', outline: 'none', cursor: 'pointer'
                        }}
                    >
                        <option value="precise">Claire (More Precise)</option>
                        <option value="commented">Sophia (More Comments)</option>
                        <option value="analytical">Prudence (Think Harder)</option>
                    </select>

                    <button
                        onClick={handleGenerateTests}
                        style={{
                            background: 'rgba(139, 92, 246, 0.15)', border: '1px solid var(--purple)', color: 'var(--text)',
                            padding: '4px 12px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'
                        }}
                    >
                        Auto-Test & Heal
                    </button>

                    {/* NEW: Self-Evolution Toggle Button */}
                    <button
                        onClick={handleToggleMetaMode}
                        style={{
                            background: metaMode ? 'rgba(255, 77, 77, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                            border: `1px solid ${metaMode ? '#ff4d4d' : 'var(--border)'}`,
                            color: metaMode ? '#ff4d4d' : 'var(--text)',
                            padding: '4px 12px', borderRadius: '4px', fontSize: '11px',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                            transition: 'all 0.3s ease'
                        }}
                        title="Enable Self-Evolution Mode"
                    >
                        {metaMode ? '🧬 Evolving...' : 'Self-Evolve'}
                    </button>
                </div>
            </div>
        </div>
    );
}