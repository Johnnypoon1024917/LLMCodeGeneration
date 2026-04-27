import React, { useState } from 'react';

// 🚀 FIX: Accept vscode directly from App.tsx as a prop!
export const LoginModal: React.FC<{ vscode: any }> = ({ vscode }) => {
    const [token, setToken] = useState('');

    const handleLogin = () => {
        if (token.trim()) {
            vscode.postMessage({ type: 'login', token: token.trim() });
        }
    };

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(4px)',
            display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999
        }}>
            <div style={{
                backgroundColor: 'var(--vscode-editor-background)',
                padding: '28px', borderRadius: '12px',
                border: '1px solid var(--vscode-widget-border)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                width: '340px', display: 'flex', flexDirection: 'column', gap: '20px'
            }}>
                <div style={{ textAlign: 'center' }}>
                    <h2 style={{ margin: '0 0 8px 0', color: 'var(--vscode-editor-foreground)', fontSize: '20px' }}>
                        🛡️ Nexus Security
                    </h2>
                    <p style={{ margin: 0, color: 'var(--vscode-descriptionForeground)', fontSize: '13px', lineHeight: '1.4' }}>
                        Zero-Trust Architecture enforced. Please authenticate to access the Swarm.
                    </p>
                </div>
                
                <input
                    type="password"
                    placeholder="Enter Enterprise Access Token..."
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                    autoFocus
                    style={{
                        padding: '10px 12px', background: 'var(--vscode-input-background)',
                        color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)',
                        borderRadius: '6px', outline: 'none', fontSize: '14px', width: '100%', boxSizing: 'border-box'
                    }}
                />
                
                <button 
                    onClick={handleLogin} 
                    disabled={!token.trim()}
                    style={{
                        padding: '10px 16px', background: 'var(--vscode-button-background)',
                        color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: '6px',
                        cursor: token.trim() ? 'pointer' : 'not-allowed', fontWeight: 'bold', fontSize: '14px',
                        opacity: token.trim() ? 1 : 0.6, transition: 'opacity 0.2s'
                    }}>
                    Authenticate
                </button>
            </div>
        </div>
    );
};