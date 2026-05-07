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
exports.VSCodeEnvironment = void 0;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const logger_1 = require("../logger");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class VSCodeEnvironment {
    async readFile(filepath) {
        const uri = vscode.Uri.file(filepath);
        const data = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(data);
    }
    async writeFile(filepath, content) {
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filepath), Buffer.from(content, 'utf8'));
    }
    async deleteFile(filepath) {
        await vscode.workspace.fs.delete(vscode.Uri.file(filepath));
    }
    async runCommand(cmd, cwd) {
        return await execAsync(cmd, { cwd });
    }
    log(message, _type, _details) {
        logger_1.log.info(`[VSCode] ${message}`);
        // We will still pass the logCallback separately for the UI streaming, 
        // but this gives the environment a base logger.
    }
}
exports.VSCodeEnvironment = VSCodeEnvironment;
//# sourceMappingURL=VSCodeEnvironment.js.map