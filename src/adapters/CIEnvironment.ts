import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { IEnvironment } from '../interfaces/IEnvironment';

const execAsync = promisify(exec);

export class CIEnvironment implements IEnvironment {
    async readFile(filepath: string): Promise<string> {
        return await fs.readFile(filepath, 'utf8');
    }

    async writeFile(filepath: string, content: string): Promise<void> {
        await fs.writeFile(filepath, content, 'utf8');
    }

    async deleteFile(filepath: string): Promise<void> {
        await fs.unlink(filepath);
    }

    async runCommand(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
        return await execAsync(cmd, { cwd });
    }

    log(message: string, type?: string, details?: string): void {
        process.stdout.write(`[NEXUS-CI] ${message}\n`);
    }
}