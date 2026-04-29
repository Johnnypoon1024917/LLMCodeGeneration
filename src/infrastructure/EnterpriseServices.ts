import * as vscode from 'vscode';
import { t } from '../i18n';
import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from '../logger';
import { getDeps } from '../container';

export class AuthManager {
    static async login(token: string) {
        await getDeps().secrets.store('nexus_auth_token', token);
    }

    static async logout() {
        await getDeps().secrets.delete('nexus_auth_token');
    }

    static async getToken(): Promise<string | undefined> {
        return await getDeps().secrets.get('nexus_auth_token');
    }

    static async isAuthenticated(): Promise<boolean> {
        const token = await this.getToken();
        return !!token; // Returns true if token exists
    }
}

export class AccessControl {
    static async verifyAccess(): Promise<boolean> {
        const isAuth = await AuthManager.isAuthenticated();
        if (!isAuth) {
            vscode.window.showErrorMessage(t("security.access_denied_swarm"));
            return false;
        }
        
        // 🚀 FUTURE EXPANSION: Add API call here to verify token validity and check quota limits
        return true;
    }
}

export class AuditLogger {
    /**
     * Dumps interaction logs to a JSONL file for Enterprise SIEM ingestion (Splunk/Datadog)
     */
    static async logInteraction(
        workspaceRoot: string, 
        eventType: "SWARM_START" | "LLM_GENERATION" | "SWARM_COMPLETE" | "ERROR", 
        details: any
    ) {
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
        } catch (e) {
            log.warn("Critical Failure in Audit Logger:", e);
        }
    }
}