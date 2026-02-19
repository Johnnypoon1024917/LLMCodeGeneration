import React, { useState, useRef, useEffect } from 'react';
import { vscode } from './vscode'; // Utility for messaging (define below)
import App from './App';

const App: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [log, setLog] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Listen for chunks from extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'chunk') {
        setLog((prev) => prev + message.value);
        logRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }, []);

  const sendPrompt = () => {
    if (!prompt.trim()) return;
    setIsLoading(true);
    setLog('');
    vscode.postMessage({ type: 'prompt', value: prompt });
  };

  const stopStream = () => {
    vscode.postMessage({ type: 'stop' });
    setIsLoading(false);
  };

  const acceptCode = () => {
    vscode.postMessage({ type: 'accept' });
    setLog(''); // Optional: Clear log after accept
  };

  return (
    <div style={{ padding: '10px', fontFamily: 'var(--vscode-font-family)' }}>
      <vscode-text-area
        value={prompt}
        onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
        placeholder="Ask the AI to generate code..."
        rows={4}
        style={{ width: '100%', marginBottom: '10px' }}
      />
      <div style={{ display: 'flex', gap: '8px', marginBottom: '15px' }}>
        <vscode-button onClick={sendPrompt} disabled={isLoading}>Send</vscode-button>
        <vscode-button onClick={stopStream} disabled={!isLoading}>Stop</vscode-button>
        <vscode-button onClick={acceptCode}>Accept Code</vscode-button>
      </div>
      {isLoading && <vscode-progress-ring />}
      <div
        ref={logRef}
        style={{
          whiteSpace: 'pre-wrap',
          fontFamily: 'monospace',
          background: 'var(--vscode-panel-background)',
          padding: '8px',
          border: '1px solid var(--vscode-panel-border)',
          maxHeight: '300px',
          overflowY: 'auto',
        }}
      >
        {log || 'No response yet...'}
      </div>
    </div>
  );
};

export default App;