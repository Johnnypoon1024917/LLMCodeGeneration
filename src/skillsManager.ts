// src/skillsManager.ts

import * as vscode from 'vscode';

export class SkillsManager {
    /**
     * Checks if the user's prompt is trying to trigger a custom Markdown Skill
     * e.g., "/review-pr Check the latest changes"
     */
    public static async processSkill(
        workspaceRoot: string,
        query: string
    ): Promise<{ isSkill: boolean; skillPrompt: string; originalQuery: string }> {
        const match = query.trim().match(/^(\/[a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
        if (!match || match[1] === undefined) return { isSkill: false, skillPrompt: "", originalQuery: query };

        const skillName = match[1].substring(1); // remove the leading slash
        const restOfQuery = match[2] ?? "";

        const skillUri = vscode.Uri.joinPath(
            vscode.Uri.file(workspaceRoot),
            '.nexus', 'skills', `${skillName}.md`
        );

        try {
            const data = await vscode.workspace.fs.readFile(skillUri);
            const skillContent = Buffer.from(data).toString('utf8');

            const skillPrompt = `CUSTOM SKILL ACTIVATED: /${skillName}

You MUST strictly follow these workflow instructions defined by the user:

---
${skillContent}
---

User's Target Request:
${restOfQuery}`;

            return { isSkill: true, skillPrompt, originalQuery: restOfQuery };
        } catch {
            // File doesn't exist — treat as a normal chat message
            return { isSkill: false, skillPrompt: "", originalQuery: query };
        }
    }

    /**
     * Helper to quickly scaffold the .nexus/skills/ directory with a sample skill.
     * Idempotent: doesn't overwrite an existing sample.
     */
    public static async initializeSkillsDirectory(workspaceRoot: string): Promise<void> {
        const skillsDir = vscode.Uri.joinPath(
            vscode.Uri.file(workspaceRoot),
            '.nexus', 'skills'
        );
        try {
            await vscode.workspace.fs.createDirectory(skillsDir);

            const sampleSkillUri = vscode.Uri.joinPath(skillsDir, 'docker.md');
            const sampleContent =
`# Docker Expert

When the user invokes \`/docker\`, audit their Docker setup:

1. Check the Dockerfile for multi-stage builds and Alpine base images.
2. Check docker-compose.yml for healthchecks and resource limits.
3. Flag any \`COPY . .\` lines without a preceding \`.dockerignore\`.
4. Suggest concrete diffs, not abstract advice.
`;

            try {
                await vscode.workspace.fs.stat(sampleSkillUri);
                // Already exists — leave the user's version alone
            } catch {
                await vscode.workspace.fs.writeFile(sampleSkillUri, Buffer.from(sampleContent, 'utf8'));
            }
        } catch {
            // Couldn't create the directory — non-fatal
        }
    }
}