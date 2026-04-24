// src/agents/verificationAgent.ts
import * as path from 'path';
import { CodeDiff } from './Coordinator';
import { askQwenToVerifyTask } from '../llmService';
import { IEnvironment } from '../interfaces/IEnvironment';

function getLanguageCommands(filepath: string): { 
    compileCmd: string | null; 
    installCmd: ((pkgs: string[]) => string) | null; 
    missingPkgRegex: RegExp | null 
} {
    const ext = path.extname(filepath).toLowerCase();
    switch (ext) {
        case '.ts':
        case '.tsx':
            return {
                compileCmd: `npx -p typescript tsc --noEmit --esModuleInterop --skipLibCheck "${filepath}"`,
                installCmd: (pkgs) => {
                    const pkgList = pkgs.join(' ');
                    const typesList = pkgs.map(p => `@types/${p}`).join(' ');
                    return `npm install ${pkgList} --no-audit --no-fund && npm install -D ${typesList} --no-audit --no-fund`;
                },
                missingPkgRegex: /Cannot find module '([^']+)'/
            };
        case '.js':
        case '.jsx':
            return {
                compileCmd: `node -c "${filepath}"`, 
                installCmd: (pkgs) => `npm install ${pkgs.join(' ')} --no-audit --no-fund`,
                missingPkgRegex: /Cannot find module '([^']+)'/
            };
        case '.py':
            return {
                compileCmd: `python -m py_compile "${filepath}"`,
                installCmd: (pkgs) => `pip install ${pkgs.join(' ')}`,
                missingPkgRegex: /ModuleNotFoundError: No module named '([^']+)'/
            };
        case '.go':
            return {
                compileCmd: `go build -o /dev/null "${filepath}"`,
                installCmd: (pkgs) => `go get ${pkgs.join(' ')}`,
                missingPkgRegex: /cannot find package "([^"]+)"/
            };
        case '.java':
            return {
                compileCmd: `javac "${filepath}"`,
                installCmd: null,
                missingPkgRegex: /package ([^\s]+) does not exist/
            };
        default:
            return { compileCmd: null, installCmd: null, missingPkgRegex: null }; 
    }
}

export async function runVerificationAgent(
    env: IEnvironment,
    techSpec: string,
    draftDiff: CodeDiff,
    workspaceRoot: string,
    testCommand: string | undefined,
    logCallback: (msg: string, stepType?: string, details?: string) => void
): Promise<{ passed: boolean; critique: string; usage?: any }> {

    logCallback(`Verifier: Starting real-world verification for ${draftDiff.filepath}...`, "tool", "Applying patch to sandbox.");

    const absolutePath = path.join(workspaceRoot, draftDiff.filepath);
    let originalContent = "";
    let fileExisted = true;

    try { originalContent = await env.readFile(absolutePath); } 
    catch (e) { fileExisted = false; }

    try {
        let newContent = originalContent;
        const fullOutput = (draftDiff.fullOutputBuffer || "").replace(/\r\n/g, '\n');
        
        const blockRegex = /<<<<SEARCH\s*?\n([\s\S]*?)\n\s*?====\s*?\n([\s\S]*?)\n\s*?>>>>REPLACE/g;
        const matches = [...fullOutput.matchAll(blockRegex)];

        if (matches.length > 0) {
            const lastMatch = matches[matches.length - 1];
            const searchBlock = lastMatch[1].replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
            const replaceBlock = lastMatch[2].replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();

            const normalizeNL = (str: string) => str.replace(/\r\n/g, '\n');
            const normOriginal = normalizeNL(originalContent);
            const normSearch = normalizeNL(searchBlock);
            const normReplace = normalizeNL(replaceBlock);

            if (normOriginal.includes(normSearch)) {
                newContent = normOriginal.replace(normSearch, () => normReplace);
            } else {
                return { passed: false, critique: `SEARCH block did not match the file. You hallucinated the code or messed up the indentation. Look at the original file and try again.\n\nYour Search Block:\n${searchBlock}` };
            }
        } else {
            const markdownMatch = fullOutput.match(/```[a-z]*\n([\s\S]*?)```/i);
            if (markdownMatch) {
                newContent = markdownMatch[1].trim();
            } else {
                newContent = fullOutput.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
            }
        }

        await env.writeFile(absolutePath, newContent);

        const { compileCmd, installCmd, missingPkgRegex } = getLanguageCommands(absolutePath);
        
        let compiled = false;
        let compilerOutput = "";
        let retryCount = 0;
        const MAX_INSTALL_RETRIES = 2;

        if (compileCmd) {
            logCallback(`Verifier: Compiling file...`, "tool", compileCmd);
            while (!compiled && retryCount <= MAX_INSTALL_RETRIES) {
                try {
                    await env.runCommand(compileCmd, workspaceRoot);
                    compiled = true; 
                } catch (error: any) {
                    compilerOutput = error.stdout || error.stderr || error.message;

                    if (compilerOutput.includes("COMMON COMMANDS") || compilerOutput.includes("Version ")) {
                        throw new Error(`Compiler failed to target the file. Output: ${compilerOutput}`);
                    }

                    const targetFileName = path.basename(absolutePath);
                    const errorLines = compilerOutput.split('\n').filter(line => {
                        // 🚀 THE TEMPORAL IMPORT FIX: Ignore missing LOCAL files (starting with . or /)
                        if (line.match(/Cannot find module '[\.\/]/) || line.match(/File '.*' is not a module/)) {
                            return false; 
                        }

                        const hasTargetFile = line.includes(targetFileName);
                        const hasMissingModule = missingPkgRegex ? new RegExp(missingPkgRegex.source, missingPkgRegex.flags).test(line) : false;
                        return hasTargetFile || hasMissingModule;
                    });
                    
                    const filteredOutput = errorLines.join('\n').trim();
                    const outputHasMissingModule = missingPkgRegex ? new RegExp(missingPkgRegex.source, missingPkgRegex.flags).test(filteredOutput) : false;
                    
                    if (!filteredOutput.includes(targetFileName) && !outputHasMissingModule) {
                        compiled = true;
                        continue; 
                    }

                    let installedSomething = false;
                    if (missingPkgRegex && installCmd && retryCount < MAX_INSTALL_RETRIES) {
                        const globalRegex = new RegExp(missingPkgRegex.source, missingPkgRegex.flags.includes('g') ? missingPkgRegex.flags : missingPkgRegex.flags + 'g');
                        const matches = [...compilerOutput.matchAll(globalRegex)];
                        
                        const missingPackages = new Set<string>(); 
                        
                        for (const match of matches) {
                            const moduleName = match[1].trim();
                            if (!moduleName.startsWith('.') && !moduleName.startsWith('/')) {
                                missingPackages.add(moduleName);
                            }
                        }

                        if (missingPackages.size > 0) {
                            const packageArray = Array.from(missingPackages);
                            const installStr = installCmd(packageArray);
                            logCallback(`Verifier: 📦 Batch installing ${packageArray.length} missing dependencies: [${packageArray.join(', ')}]...`, "tool", installStr);
                            
                            try {
                                await env.runCommand(installStr, workspaceRoot);
                                installedSomething = true;
                                retryCount++;
                            } catch (installErr: any) {
                                compilerOutput = `Failed to batch install [${packageArray.join(', ')}]: ${installErr.message}\n\nCompiler Error:\n${filteredOutput}`;
                            }
                        }
                    }

                    if (installedSomething) {
                        continue; 
                    } else {
                        compilerOutput = filteredOutput;
                        break; 
                    }
                }
            }

            if (!compiled) {
                if (fileExisted) await env.writeFile(absolutePath, originalContent);
                else await env.deleteFile(absolutePath);
                return { passed: false, critique: `🚨 COMPILER ERROR DETECTED 🚨\n\n${compilerOutput}\n\nYou MUST fix these exact errors in your next attempt.` };
            }
        }

        if (testCommand) {
            logCallback(`Verifier: Code compiled. Running TDD Suite...`, "tool", testCommand);
            try {
                await env.runCommand(testCommand, workspaceRoot);
                logCallback(`Verifier: 🧪 All TDD tests passed!`, "success");
            } catch (testErr: any) {
                const failureLog = testErr.stdout || testErr.stderr || testErr.message;
                if (fileExisted) await env.writeFile(absolutePath, originalContent);
                else await env.deleteFile(absolutePath);
                return { passed: false, critique: `🚨 TDD TEST FAILURE 🚨\n\nYour code compiled, but it FAILED the PRD Business Rules.\n\nTest Output:\n${failureLog}\n\nYou MUST rewrite the logic to make the tests pass.` };
            }
        }

        logCallback(`Verifier: Running logical PRD review...`, "analyze", "Checking against business rules.");
        const llmVerification = await askQwenToVerifyTask(techSpec, "Review the technical spec.", newContent);

        if (fileExisted) await env.writeFile(absolutePath, originalContent);
        else await env.deleteFile(absolutePath);

        return { passed: llmVerification.verified, critique: llmVerification.reasoning, usage: llmVerification.usage };

    } catch (err: any) {
        if (fileExisted) await env.writeFile(absolutePath, originalContent);
        else await env.deleteFile(absolutePath);
        return { passed: false, critique: `Catastrophic Patch Error: ${err.message}` };
    }
}