import * as vscode from 'vscode';

export class SkillsManager {
    /**
     * Checks if the user's prompt is trying to trigger a custom Markdown Skill
     * e.g., "/review-pr Check the latest changes"
     */
    public static async processSkill(workspaceRoot: string, query: string): Promise<{ isSkill: boolean, skillPrompt: string, originalQuery: string }> {
        const match = query.trim().match(/^(\/[a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
        
        if (!match) return { isSkill: false, skillPrompt: "", originalQuery: query };

        const skillName = match[1].substring(1); // remove the slash
        const restOfQuery = match[2] || ""; 

        const skillUri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), '.nexus', 'skills', `${skillName}.md`);
        
        try {
            const data = await vscode.workspace.fs.readFile(skillUri);
            const skillContent = Buffer.from(data).toString('utf8');
            
            // 🔥 Inject the custom Markdown skill into a master directive
            const skillPrompt = `🔥 CUSTOM ENTERPRISE SKILL ACTIVATED: /${skillName} 🔥\n\nYou MUST strictly follow these workflow instructions defined by the user:\n\n---\n${skillContent}\n---\n\nUser's Target Request:\n${restOfQuery}`;
            
            return { isSkill: true, skillPrompt, originalQuery: restOfQuery };
        } catch (e) {
            // The file doesn't exist, just treat it as a normal chat message
            return { isSkill: false, skillPrompt: "", originalQuery: query };
        }
    }

    /**
     * Helper to quickly scaffold the .nexus/skills directory
     */
    public static async initializeSkillsDirectory(workspaceRoot: string) {
        const skillsDir = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), '.nexus', 'skills');
        try {
            await vscode.workspace.fs.createDirectory(skillsDir);
            
            const sampleSkillUri = vscode.Uri.joinPath(skillsDir, 'docker.md');
            const sampleContent = `# Docker Expert\nCheck my Dockerfile and docker-compose.yml. Ensure I am using Alpine images and multi-stage builds.`;
            
            try {
                await vscode.workspace.fs.stat(sampleSkillUri);
            } catch {
                await vscode.workspace.fs.writeFile(sampleSkillUri, Buffer.from(sampleContent, 'utf8'));
            }
        } catch (e) { }
    }
}