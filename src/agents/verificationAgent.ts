// src/agents/verificationAgent.ts
import * as path from 'path';
import { CodeDiff } from './Coordinator';
import { askQwenToVerifyTask } from '../llmService';
import { IEnvironment } from '../interfaces/IEnvironment';

export async function runVerificationAgent(
    env: IEnvironment,
    techSpec: string,
    draftDiff: CodeDiff,
    workspaceRoot: string,
    testCommand: string | undefined, // 🚀 TDD PARAMETER
    logCallback: (msg: string, stepType?: string, details?: string) => void
): Promise<{ passed: boolean; critique: string }> {

    logCallback(`Verifier: Starting real-world verification for ${draftDiff.filepath}...`, "tool", "Applying patch to sandbox and compiling.");

    // Use standard path instead of vscode.Uri
    const absolutePath = path.join(workspaceRoot, draftDiff.filepath);
    let originalContent = "";
    let fileExisted = true;

    // 1. Snapshot via Environment
    try {
        originalContent = await env.readFile(absolutePath);
    } catch (e) {
        fileExisted = false; 
    }

    try {
        // 2. APPLY THE DRAFT PATCH TO DISK
        let newContent = originalContent;
        if (draftDiff.searchBlock) {
            const cleanSearch = draftDiff.searchBlock.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
            const cleanReplace = draftDiff.replaceBlock.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
            if (originalContent.includes(cleanSearch)) {
                newContent = originalContent.replace(cleanSearch, cleanReplace);
            } else {
                return { passed: false, critique: "SEARCH block did not match the file. You hallucinated the code. Look at the file and try again." };
            }
        } else {
            newContent = draftDiff.fullOutputBuffer.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
        }

        // Use env instead of vscode
        await env.writeFile(absolutePath, newContent);

        // 3. REAL-WORLD TERMINAL VERIFICATION
        let compiled = false;
        let compilerOutput = "";
        let retryCount = 0;
        const MAX_INSTALL_RETRIES = 2;

        while (!compiled && retryCount <= MAX_INSTALL_RETRIES) {
            try {
                // 🚀 THE FIX: Force npx to use the 'typescript' package so it doesn't download the fake 'tsc' stub
                await env.runCommand('npx -p typescript tsc --noEmit', workspaceRoot);
                compiled = true; 
            } catch (error: any) {
                compilerOutput = error.stdout || error.message;

                const missingModuleMatch = compilerOutput.match(/Cannot find module '([^']+)'/);
                if (missingModuleMatch && retryCount < MAX_INSTALL_RETRIES) {
                    const moduleName = missingModuleMatch[1];
                    logCallback(`Verifier: 📦 Auto-installing missing dependency '${moduleName}'...`, "tool", `npm install ${moduleName}`);
                    try {
                        await env.runCommand(`npm install ${moduleName}`, workspaceRoot);
                        await env.runCommand(`npm install -D @types/${moduleName}`, workspaceRoot).catch(() => {});
                        retryCount++;
                        continue;
                    } catch (installErr: any) {
                        compilerOutput = `Failed to auto-install ${moduleName}: ${installErr.message}\n\nCompiler Error:\n${compilerOutput}`;
                        break;
                    }
                }
                break; 
            }
        }

        if (!compiled) {
            if (fileExisted) await env.writeFile(absolutePath, originalContent);
            else await env.deleteFile(absolutePath);
            return { passed: false, critique: `🚨 COMPILER ERROR DETECTED 🚨\n\n${compilerOutput}\n\nYou MUST fix these exact errors in your next attempt.` };
        }

        // 🚀 THE TDD VERIFICATION GATE
        if (testCommand) {
            logCallback(`Verifier: Code compiled. Running TDD Suite...`, "tool", testCommand);
            try {
                const testResult = await env.runCommand(testCommand, workspaceRoot);
                logCallback(`Verifier: 🧪 All TDD tests passed!`, "success");
            } catch (testErr: any) {
                const failureLog = testErr.stdout || testErr.stderr || testErr.message;
                
                // Revert the file because it failed business logic
                if (fileExisted) await env.writeFile(absolutePath, originalContent);
                else await env.deleteFile(absolutePath);
                
                return { 
                    passed: false, 
                    critique: `🚨 TDD TEST FAILURE 🚨\n\nYour code compiled, but it FAILED the PRD Business Rules.\n\nTest Output:\n${failureLog}\n\nYou MUST rewrite the logic to make the tests pass.` 
                };
            }
        }

        // 4. LOGICAL LLM VERIFICATION
        logCallback(`Verifier: Code compiled successfully. Running logical PRD review...`, "analyze", "Checking against business rules.");
        const llmVerification = await askQwenToVerifyTask(techSpec, "Review the technical spec.", newContent);

        // 5. REVERT THE SANDBOX
        if (fileExisted) await env.writeFile(absolutePath, originalContent);
        else await env.deleteFile(absolutePath);

        return { passed: llmVerification.verified, critique: llmVerification.reasoning };

    } catch (err: any) {
        if (fileExisted) await env.writeFile(absolutePath, originalContent);
        else await env.deleteFile(absolutePath);
        return { passed: false, critique: `Catastrophic Patch Error: ${err.message}` };
    }
}