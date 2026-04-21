// src/agents/verificationAgent.ts
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { CodeDiff } from './Coordinator';
import { askQwenToVerifyTask } from '../llmService';

const execAsync = promisify(exec);

export async function runVerificationAgent(
    techSpec: string,
    draftDiff: CodeDiff,
    workspaceRoot: string,
    logCallback: (msg: string, stepType?: string, details?: string) => void
): Promise<{ passed: boolean; critique: string }> {

    logCallback(`Verifier: Starting real-world verification for ${draftDiff.filepath}...`, "tool", "Applying patch to sandbox and compiling.");

    const fileUri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), draftDiff.filepath);
    let originalContent = "";
    let fileExisted = true;

    // 1. Snapshot the current state of the file
    try {
        const fileData = await vscode.workspace.fs.readFile(fileUri);
        originalContent = new TextDecoder().decode(fileData);
    } catch (e) {
        fileExisted = false; // It's a new file being created
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
            // Fallback for complete file overwrite
            newContent = draftDiff.fullOutputBuffer.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
        }

        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(newContent, 'utf8'));

        // 3. REAL-WORLD TERMINAL VERIFICATION
        // We run a dry-run TypeScript check. (In Phase 6, we will pull this command dynamically from .nexusrules)
        try {
            await execAsync('npx tsc --noEmit', { cwd: workspaceRoot });
        } catch (error: any) {
            // If the error contains TS error codes, it's a real compiler error!
            if (error.stdout && error.stdout.includes('error TS')) {
                // Revert the file before rejecting
                if (fileExisted) await vscode.workspace.fs.writeFile(fileUri, Buffer.from(originalContent, 'utf8'));
                else await vscode.workspace.fs.delete(fileUri);

                return { 
                    passed: false, 
                    critique: `🚨 COMPILER ERROR DETECTED 🚨\n\n${error.stdout}\n\nYou MUST fix these exact TypeScript errors in your next attempt.` 
                };
            }
        }

        // 4. LOGICAL LLM VERIFICATION
        logCallback(`Verifier: Code compiled successfully. Running logical PRD review...`, "analyze", "Checking against business rules.");
        
        // We use our resilient LLM service to check the business logic
        const llmVerification = await askQwenToVerifyTask(techSpec, "Review the technical spec.", newContent);

        // 5. REVERT THE SANDBOX
        // We revert the file so the SidebarProvider can apply it cleanly through the VS Code Editor API for the user to see.
        if (fileExisted) await vscode.workspace.fs.writeFile(fileUri, Buffer.from(originalContent, 'utf8'));
        else await vscode.workspace.fs.delete(fileUri);

        return {
            passed: llmVerification.verified,
            critique: llmVerification.reasoning
        };

    } catch (err: any) {
        // Ensure we revert the file if the verification loop crashes catastrophically
        if (fileExisted) await vscode.workspace.fs.writeFile(fileUri, Buffer.from(originalContent, 'utf8'));
        else await vscode.workspace.fs.delete(fileUri);
        
        return { passed: false, critique: `Catastrophic Patch Error: ${err.message}` };
    }
}