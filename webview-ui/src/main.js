"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
const client_1 = __importDefault(require("react-dom/client"));
const App_1 = __importDefault(require("./App"));
const vscode_webview_ui_toolkit_1 = require("@microsoft/vscode-webview-ui-toolkit");
require("@microsoft/vscode-webview-ui-toolkit/dist/index.css"); // Toolkit styles
// Register toolkit components
(0, vscode_webview_ui_toolkit_1.provideVSCodeDesignSystem)().register((0, vscode_webview_ui_toolkit_1.vsCodeButton)(), (0, vscode_webview_ui_toolkit_1.vsCodeTextArea)());
client_1.default.createRoot(document.getElementById('root')).render(<react_1.default.StrictMode>
    <App_1.default />
  </react_1.default.StrictMode>);
//# sourceMappingURL=main.js.map