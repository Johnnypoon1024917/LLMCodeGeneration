"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importStar(require("react"));
const vscode_1 = require("./vscode"); // Utility for messaging (define below)
const App = () => {
    const [prompt, setPrompt] = (0, react_1.useState)('');
    const [log, setLog] = (0, react_1.useState)('');
    const [isLoading, setIsLoading] = (0, react_1.useState)(false);
    const logRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => {
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
        if (!prompt.trim())
            return;
        setIsLoading(true);
        setLog('');
        vscode_1.vscode.postMessage({ type: 'prompt', value: prompt });
    };
    const stopStream = () => {
        vscode_1.vscode.postMessage({ type: 'stop' });
        setIsLoading(false);
    };
    const acceptCode = () => {
        vscode_1.vscode.postMessage({ type: 'accept' });
        setLog(''); // Optional: Clear log after accept
    };
    return (<div style={{ padding: '10px', fontFamily: 'var(--vscode-font-family)' }}>
      <vscode-text-area value={prompt} onInput={(e) => setPrompt(e.target.value)} placeholder="Ask the AI to generate code..." rows={4} style={{ width: '100%', marginBottom: '10px' }}/>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '15px' }}>
        <vscode-button onClick={sendPrompt} disabled={isLoading}>Send</vscode-button>
        <vscode-button onClick={stopStream} disabled={!isLoading}>Stop</vscode-button>
        <vscode-button onClick={acceptCode}>Accept Code</vscode-button>
      </div>
      {isLoading && <vscode-progress-ring />} {/* Loading indicator */}
      <div ref={logRef} style={{
            whiteSpace: 'pre-wrap',
            fontFamily: 'monospace',
            background: 'var(--vscode-panel-background)',
            padding: '8px',
            border: '1px solid var(--vscode-panel-border)',
            maxHeight: '300px',
            overflowY: 'auto',
        }}>
        {log || 'No response yet...'}
      </div>
    </div>);
};
exports.default = App;
//# sourceMappingURL=App.js.map