// src/llm/environment.ts
import * as os from 'os';
import { TerminalManager } from '../terminalManager';

export async function getEnvInfo(workspacePath: string, terminalManager?: TerminalManager): Promise<string> {
    let isGit = false;
    if (terminalManager && workspacePath) {
        const gitCheck = await terminalManager.runCommandWithCapture('git rev-parse --is-inside-work-tree', workspacePath);
        isGit = gitCheck?.success || false;
    }

    return `Here is useful information about the environment you are running in:
<env>
Working directory: ${workspacePath || 'Unknown'}
Is directory a git repo: ${isGit ? 'Yes' : 'No'}
Platform: ${os.platform()} (${os.release()})
Today's date: ${new Date().toLocaleDateString()}
</env>`;
}