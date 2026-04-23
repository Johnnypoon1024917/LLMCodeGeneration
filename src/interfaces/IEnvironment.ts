export interface IEnvironment {
    readFile(filepath: string): Promise<string>;
    writeFile(filepath: string, content: string): Promise<void>;
    deleteFile(filepath: string): Promise<void>;
    runCommand(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string }>;
    log(message: string, type?: string, details?: string): void;
}