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
}

export default function App() {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(false);

    // NEW: State for the agent's current background action
    const [agentStatus, setAgentStatus] = useState<string>('');
    const [codingStyle, setCodingStyle] = useState('precise');
    const [taskStatuses, setTaskStatuses] = useState<Record<string, string>>({});
    const [taskSummaries, setTaskSummaries] = useState<Record<string, string>>({});
    const [pendingEdits, setPendingEdits] = useState<any[] | null>(null);

    const chatEndRef = useRef<HTMLDivElement>(null);

    const handleInstallDependencies = () => {
        vscode.postMessage({
            type: 'runTerminalCommand',
            command: 'npm install'
        });
    };

    // NEW: Trigger for autonomous testing loop
    const handleGenerateTests = () => {
        vscode.postMessage({ type: 'generateAndRunTests' });
    };

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        const messageHandler = (event: MessageEvent) => {
            const data = event.data;
            if (data.type === 'reviewEdits') {
                setPendingEdits(data.edits); // Show the review UI
            }
            if (data.type === 'allTasksCompleted') {
                setPendingEdits(null); // Clear review UI on success
            }

            if (data.type === 'structureResponse') {
                setMessages((prev) => [
                    ...prev,
                    { role: 'assistant', plan: data.value }
                ]);
                setLoading(false);
            }
            if (data.type === 'taskCompleted' || data.type === 'taskStatusUpdate') {
                setTaskStatuses(prev => ({ ...prev, [data.task]: data.status }));
                // NEW: Save the summary if it exists
                if (data.summary) {
                    setTaskSummaries(prev => ({ ...prev, [data.task]: data.summary }));
                }
            }
            if (data.type === 'requestReview') {
                setInput(`Please review and optimize this code:\n\n\`\`\`\n${data.code}\n\`\`\``);
                setLoading(true);
                vscode.postMessage({
                    type: 'generateStructure',
                    value: `Review and optimize this code: ${data.code}`
                });
            }
            // NEW: Listen for background status updates from the backend
            if (data.type === 'statusUpdate') {
                setAgentStatus(data.message);
            }
            // NEW: Auto-Healing Trigger. If the backend reports an error, prompt Qwen automatically
            if (data.type === 'terminalError') {
                const errorPrompt = `I ran the command '${data.command}' and got this error:\n\n\`\`\`\n${data.error}\n\`\`\`\n\nPlease fix the code to resolve this error.`;
                setMessages((prev) => [...prev, { role: 'user', content: errorPrompt }]);
                setLoading(true);
                vscode.postMessage({ type: 'generateStructure', value: errorPrompt });
            }
        };
        window.addEventListener('message', messageHandler);
        return () => window.removeEventListener('message', messageHandler);
    }, []);

    const handleSubmit = () => {
        if (!input.trim() || loading) return;

        setMessages((prev) => [...prev, { role: 'user', content: input }]);
        setLoading(true);

        vscode.postMessage({ type: 'generateStructure', value: input });

        setInput('');
        const textarea = document.getElementById('chat-input');
        if (textarea) textarea.style.height = 'auto';
    };

    const handleCommit = () => {
        vscode.postMessage({
            type: 'commitAtomicEdits',
            edits: pendingEdits
        });
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
    };

    return (
        <div className="app-wrapper">
            <div className="tiny-header">
                <span>Nexuscoder</span>
                <span className="version">v0.1</span>
            </div>

            <div className="chat-container">
                {messages.length === 0 && (
                    <div className="empty-state">
                        <h2>How can I help you build today?</h2>
                        <p>Ask me to generate code, plans, structures...</p>
                    </div>
                )}

                {messages.map((msg, idx) => (
                    <div key={idx} className={`message ${msg.role}`}>
                        {msg.role === 'user' && <div className="user-bubble">{msg.content}</div>}

                        {msg.role === 'assistant' && msg.plan && (
                            <div className="plan-card">
                                <div style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    marginBottom: '16px'
                                }}>
                                    <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', color: 'var(--text)', fontWeight: 600 }}>Implementation Plan</h3>
                                    {/* NEW: EXECUTE ALL BUTTON */}
                                    <button
                                        onClick={() => {
                                            if (msg.plan) {
                                                vscode.postMessage({
                                                    type: 'executeAllTasks',
                                                    tasks: msg.plan.implementationTasks,
                                                    codingStyle: codingStyle
                                                });
                                            }
                                        }}
                                        style={{
                                            background: 'var(--purple)',
                                            color: 'white',
                                            border: 'none',
                                            padding: '4px 10px',
                                            borderRadius: '4px',
                                            fontSize: '11px',
                                            cursor: 'pointer',
                                            fontWeight: 600
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
                                                display: 'flex',
                                                flexDirection: 'column', // FIX 1: Stack children vertically
                                                gap: '4px',
                                                background: 'rgba(0,0,0,0.15)',
                                                padding: '8px 10px',
                                                borderRadius: '6px',
                                                border: '1px solid var(--border)',
                                                width: '100%',
                                                boxSizing: 'border-box'
                                            }}>
                                                {/* TOP ROW: Number, Name, Status */}
                                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', width: '100%' }}>
                                                    <div style={{
                                                        color: 'var(--subtext)', fontSize: '10px',
                                                        background: 'rgba(255,255,255,0.05)', width: '18px',
                                                        height: '18px', display: 'flex', alignItems: 'center',
                                                        justifyContent: 'center', borderRadius: '50%',
                                                        flexShrink: 0, marginTop: '1px'
                                                    }}>
                                                        {tIdx + 1}
                                                    </div>

                                                    <div style={{
                                                        flex: 1, fontSize: '12px', lineHeight: '1.3',
                                                        color: 'var(--text)', wordBreak: 'break-word', overflowWrap: 'anywhere'
                                                    }}>
                                                        {task}
                                                    </div>

                                                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                                                        {status === 'reviewing' && (
                                                            <span className="status-reviewing" style={{ fontSize: '11px', color: '#ffb000', fontWeight: 600 }}>
                                                                ⏳ Reviewing
                                                            </span>
                                                        )}
                                                        {status === 'approved' && <span style={{ fontSize: '11px', color: '#4CAF50', fontWeight: 600 }}>✅ Approved</span>}
                                                        {status === 'rejected' && <span style={{ fontSize: '11px', color: '#f44336', fontWeight: 600 }}>❌ Rejected</span>}
                                                        {status === 'error' && <span style={{ fontSize: '11px', color: '#f44336', fontWeight: 600 }}>⚠️ Error</span>}

                                                        {!status && (
                                                            <button
                                                                title="Run this step"
                                                                style={{
                                                                    background: 'transparent', color: 'var(--subtext)',
                                                                    border: 'none', cursor: 'pointer', padding: '4px',
                                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                                    borderRadius: '4px', transition: 'all 0.2s ease'
                                                                }}
                                                                onMouseOver={(e) => {
                                                                    e.currentTarget.style.color = 'var(--purple)';
                                                                    e.currentTarget.style.background = 'rgba(139, 92, 246, 0.15)';
                                                                }}
                                                                onMouseOut={(e) => {
                                                                    e.currentTarget.style.color = 'var(--subtext)';
                                                                    e.currentTarget.style.background = 'transparent';
                                                                }}
                                                                onClick={() => {
                                                                    setTaskStatuses(prev => ({ ...prev, [task]: 'reviewing' }));
                                                                    vscode.postMessage({
                                                                        type: 'executeTask',
                                                                        task: task,
                                                                        availableFiles: msg.plan?.folderStructure,
                                                                        codingStyle: codingStyle,
                                                                        history: messages
                                                                    });
                                                                }}
                                                            >
                                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                                                                </svg>
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* BOTTOM ROW: Summary Text (Only renders if summary exists) */}
                                                {summary && (
                                                    <div style={{
                                                        marginLeft: '28px', // Indent to align with text
                                                        fontSize: '11px',
                                                        color: status === 'approved' ? '#4CAF50' : 'var(--subtext)',
                                                        fontStyle: 'italic',
                                                        marginTop: '2px'
                                                    }}>
                                                        {summary}
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

                {/* NEW: Review Edits Overlay */}
                {pendingEdits && (
                    <div className="review-overlay" style={{
                        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                        background: 'var(--bg)', zIndex: 100, padding: '20px',
                        display: 'flex', flexDirection: 'column'
                    }}>
                        <h3>Review Proposed Edits</h3>
                        <p style={{ fontSize: '12px', color: 'var(--subtext)' }}>
                            NexusCode has drafted changes for {pendingEdits.length} files.
                        </p>

                        <div style={{ flex: 1, overflowY: 'auto', marginBottom: '20px' }}>
                            {pendingEdits.map((edit, i) => (
                                <div key={i} style={{
                                    border: '1px solid var(--border)', padding: '8px',
                                    marginBottom: '8px', borderRadius: '4px'
                                }}>
                                    <div style={{ fontSize: '11px', fontWeight: 'bold' }}>{edit.filepath}</div>
                                    <div style={{ fontSize: '10px', color: 'var(--purple)' }}>Action: {edit.action}</div>
                                </div>
                            ))}
                        </div>

                        <div style={{ display: 'flex', gap: '10px' }}>
                            <button className="submit-btn" style={{ flex: 1, borderRadius: '8px' }} onClick={handleCommit}>
                                Commit All Changes
                            </button>
                            <button
                                className="submit-btn"
                                style={{ flex: 1, borderRadius: '8px', background: 'transparent', border: '1px solid var(--border)' }}
                                onClick={() => setPendingEdits(null)}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {loading && (
                    <div className="message assistant">
                        <div className="user-bubble" style={{ background: 'var(--input-bg)', color: 'var(--text)' }}>
                            <span className="spinner">⏳</span> {agentStatus || "Thinking..."}
                        </div>
                    </div>
                )}
                <div ref={chatEndRef} />
            </div>

            <div className="input-container">
                {/* NEW: Agent Status Banner */}
                {agentStatus && (
                    <div style={{
                        padding: '8px 12px',
                        background: 'rgba(139, 92, 246, 0.1)',
                        border: '1px solid var(--purple)',
                        borderRadius: '8px',
                        fontSize: '12px',
                        color: 'var(--purple)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        marginBottom: '10px'
                    }}>
                        <span className="spinner">⏳</span> {agentStatus}
                    </div>
                )}

                <div className="input-box">
                    <textarea
                        id="chat-input"
                        value={input}
                        onChange={handleInput}
                        onKeyDown={handleKeyDown}
                        placeholder="Ask anything..."
                        rows={1}
                    />
                    <button
                        className="submit-btn"
                        onClick={handleSubmit}
                        disabled={loading || !input.trim()}
                    >
                        ↑
                    </button>
                </div>

                {/* Updated Action Bar */}
                <div className="input-hint" style={{ display: 'flex', justifyContent: 'center', gap: '10px', alignItems: 'center', marginTop: '12px' }}>
                    <select
                        value={codingStyle}
                        onChange={(e) => setCodingStyle(e.target.value)}
                        style={{
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'var(--subtext)',
                            border: '1px solid var(--border)',
                            borderRadius: '4px',
                            padding: '4px 8px',
                            fontSize: '11px',
                            outline: 'none',
                            cursor: 'pointer'
                        }}
                    >
                        <option value="precise">Claire (More Precise)</option>
                        <option value="commented">Sophia (More Comments)</option>
                        <option value="analytical">Prudence (Think Harder)</option>
                    </select>

                    {/* NEW: Auto-Test Generation Trigger Button */}
                    <button
                        onClick={handleGenerateTests}
                        style={{
                            background: 'rgba(139, 92, 246, 0.15)',
                            border: '1px solid var(--purple)',
                            color: 'var(--text)',
                            padding: '4px 12px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                        }}
                        onMouseOver={(e) => e.currentTarget.style.background = 'rgba(139, 92, 246, 0.3)'}
                        onMouseOut={(e) => e.currentTarget.style.background = 'rgba(139, 92, 246, 0.15)'}
                    >
                        Auto-Test & Heal
                    </button>
                </div>
            </div>


        </div>
    );
}