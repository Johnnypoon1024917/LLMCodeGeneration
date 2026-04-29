import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { IEnvironment } from '../interfaces/IEnvironment';
import { log } from '../logger';

const execAsync = promisify(exec);

export class VSCodeEnvironment implements IEnvironment {
    async readFile(filepath: string): Promise<string> {
        const uri = vscode.Uri.file(filepath);
        const data = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(data);
    }

    async writeFile(filepath: string, content: string): Promise<void> {
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filepath), Buffer.from(content, 'utf8'));
    }

    async deleteFile(filepath: string): Promise<void> {
        await vscode.workspace.fs.delete(vscode.Uri.file(filepath));
    }

    async runCommand(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
        return await execAsync(cmd, { cwd });
    }

    log(message: string, _type?: string, _details?: string): void {
        log.info(`[VSCode] ${message}`);
        // We will still pass the logCallback separately for the UI streaming, 
        // but this gives the environment a base logger.
    }
}