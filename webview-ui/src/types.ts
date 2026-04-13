// webview-ui/src/types.ts
export interface ProjectTask {
    step: string;
    file: string;
    detailedInstructions: string;
    relatedRequirement: string;
}

export interface AIPlan {
    folderStructure: string[];
    implementationTasks: (string | ProjectTask)[];
}

export interface AttachedContext {
    file: string;
    code: string;
    language: string;
}

export interface AtomicEdit {
    filepath: string;
    code: string;
    action: 'replace' | 'append' | 'inject';
    target?: string;
}

export interface AgentStep {
    type: string;
    description: string;
    details?: string;
}

export interface Message {
    role: 'user' | 'assistant';
    content?: string;
    plan?: AIPlan;
    attachments?: AttachedContext[];
    isCompacted?: boolean;
}