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
exports.AuditLogger = exports.AccessControl = exports.AuthManager = void 0;
const vscode = __importStar(require("vscode"));
const i18n_1 = require("../i18n");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const logger_1 = require("../logger");
const container_1 = require("../container");
class AuthManager {
    static async login(token) {
        await (0, container_1.getDeps)().secrets.store('nexus_auth_token', token);
    }
    static async logout() {
        await (0, container_1.getDeps)().secrets.delete('nexus_auth_token');
    }
    static async getToken() {
        return await (0, container_1.getDeps)().secrets.get('nexus_auth_token');
    }
    static async isAuthenticated() {
        const token = await this.getToken();
        return !!token; // Returns true if token exists
    }
}
exports.AuthManager = AuthManager;
class AccessControl {
    static async verifyAccess() {
        const isAuth = await AuthManager.isAuthenticated();
        if (!isAuth) {
            vscode.window.showErrorMessage((0, i18n_1.t)("security.access_denied_swarm"));
            return false;
        }
        // 🚀 FUTURE EXPANSION: Add API call here to verify token validity and check quota limits
        return true;
    }
}
exports.AccessControl = AccessControl;
class AuditLogger {
    /**
     * Dumps interaction logs to a JSONL file for Enterprise SIEM ingestion (Splunk/Datadog)
     */
    static async logInteraction(workspaceRoot, eventType, details) {
        try {
            const logDir = path.join(workspaceRoot, '.nexuscode', 'logs');
            await fs.mkdir(logDir, { recursive: true });
            const logFile = path.join(logDir, 'audit_log.jsonl');
            // Grab the user identity if possible (fallback to local OS user)
            const user = (await AuthManager.getToken()) ? "AuthenticatedUser" : process.env['USER'] || "Anonymous";
            const logEntry = {
                timestamp: new Date().toISOString(),
                user: user,
                event: eventType,
                ...details
            };
            await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n', 'utf8');
        }
        catch (e) {
            logger_1.log.warn("Critical Failure in Audit Logger:", e);
        }
    }
}
exports.AuditLogger = AuditLogger;
//# sourceMappingURL=EnterpriseServices.js.map