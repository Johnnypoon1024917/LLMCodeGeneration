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
    const chatEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        const messageHandler = (event: MessageEvent) => {
            const message = event.data;
            if (message.type === 'structureResponse') {
                setMessages((prev) => [
                    ...prev,
                    { role: 'assistant', plan: message.value }
                ]);
                setLoading(false);
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

        // Reset input and height
        setInput('');
        const textarea = document.getElementById('chat-input');
        if (textarea) textarea.style.height = 'auto';
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    // Auto-expand the textarea as the user types
    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
    };



    const [codingStyle, setCodingStyle] = useState('precise');


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

                        {/* FIX: Put the actual rendering logic back in! */}
                        {msg.role === 'assistant' && msg.plan && (
                            <div className="plan-card">
                                <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', color: 'var(--text)', fontWeight: 600 }}>Implementation Plan</h3>

                                {/* Sleek File Badges */}
                                <div style={{ marginBottom: '20px' }}>
                                    <div style={{ fontSize: '12px', color: 'var(--subtext)', marginBottom: '8px' }}>Created Files:</div>
                                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                        {msg.plan.folderStructure.map((file, fIdx) => (
                                            <div key={fIdx} style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '6px',
                                                background: 'rgba(0, 0, 0, 0.2)',
                                                border: '1px solid var(--border)',
                                                padding: '4px 10px',
                                                borderRadius: '6px',
                                                fontSize: '12px',
                                                fontFamily: 'var(--vscode-editor-font-family)'
                                            }}>
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                                                <span style={{ color: 'var(--text)' }}>{file}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Premium Task List */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}> {/* Reduced gap from 8px to 4px */}
                                    {msg.plan.implementationTasks.map((task, tIdx) => (
                                        <div key={tIdx} style={{
                                            display: 'flex',
                                            alignItems: 'flex-start',
                                            gap: '10px',
                                            background: 'rgba(0,0,0,0.15)',
                                            padding: '8px 10px', /* Reduced padding for a tighter look */
                                            borderRadius: '6px',
                                            border: '1px solid var(--border)',
                                            width: '100%', /* CRITICAL: Forces all rows to be the exact same width */
                                            boxSizing: 'border-box' /* Ensures padding doesn't break the width */
                                        }}>
                                            {/* Step Number Badge */}
                                            <div style={{
                                                color: 'var(--subtext)',
                                                fontSize: '10px', /* Smaller badge */
                                                background: 'rgba(255,255,255,0.05)',
                                                width: '18px',
                                                height: '18px',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                borderRadius: '50%',
                                                flexShrink: 0,
                                                marginTop: '1px' /* Aligns badge perfectly with tighter text */
                                            }}>
                                                {tIdx + 1}
                                            </div>

                                            {/* Task Text - Tighter & wrapped */}
                                            <div style={{
                                                flex: 1,
                                                fontSize: '12px', /* Smaller font size */
                                                lineHeight: '1.3', /* Tighter line height for packed text */
                                                color: 'var(--text)',
                                                wordBreak: 'break-word', /* Prevents long strings from breaking layout */
                                                overflowWrap: 'anywhere'
                                            }}>
                                                {task}
                                            </div>

                                            {/* Tiny SVG Play Button - Locked to the right */}
                                            <button
                                                title="Run this step"
                                                style={{
                                                    background: 'transparent',
                                                    color: 'var(--subtext)',
                                                    border: 'none',
                                                    cursor: 'pointer',
                                                    padding: '4px',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    borderRadius: '4px',
                                                    flexShrink: 0,
                                                    marginTop: '-2px', /* Nudges icon up slightly to align with first row of text */
                                                    marginLeft: 'auto', /* Guarantee it pushes to the absolute right */
                                                    transition: 'all 0.2s ease'
                                                }}
                                                onMouseOver={(e) => {
                                                    e.currentTarget.style.color = 'var(--purple)';
                                                    e.currentTarget.style.background = 'rgba(139, 92, 246, 0.15)';
                                                }}
                                                onMouseOut={(e) => {
                                                    e.currentTarget.style.color = 'var(--subtext)';
                                                    e.currentTarget.style.background = 'transparent';
                                                }}
                                                onClick={() => vscode.postMessage({
                                                    type: 'executeTask',
                                                    task: task,
                                                    availableFiles: msg.plan?.folderStructure,
                                                    codingStyle: codingStyle
                                                })}
                                            >
                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>

                            </div>
                        )}
                    </div>
                ))}

                {loading && <div className="message assistant"><div className="user-bubble" style={{ background: 'var(--input-bg)', color: 'var(--text)' }}>Thinking...</div></div>}
                <div ref={chatEndRef} />
            </div>

            <div className="input-container">
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
                <div className="input-hint">
                    <select
                        value={codingStyle}
                        onChange={(e) => setCodingStyle(e.target.value)}
                        style={{
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'var(--subtext)',
                            border: '1px solid var(--border)',
                            borderRadius: '4px',
                            padding: '2px 6px',
                            fontSize: '11px',
                            outline: 'none',
                            cursor: 'pointer'
                        }}
                    >
                        <option value="precise">Claire (More Precise)</option>
                        <option value="commented">Sophia (More Comments)</option>
                        <option value="analytical">Prudence (Think Harder)</option>
                    </select>
                </div>
            </div>
        </div>
    );
}