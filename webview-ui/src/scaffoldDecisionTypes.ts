// webview-ui/src/scaffoldDecisionTypes.ts
//
// V2.1.2b — shared type for template metadata in the webview side
// of the scaffold decision flow. Mirrors the host's TemplateMetadata
// shape (minus rootPath, which the webview doesn't need or want).
//
// Kept in its own file so both scaffoldDecisionState.ts and the
// dialog component can import it without circular dependencies.

export interface TemplateInfo {
    id: string;
    displayName: string;
    description: string;
    stackTags: string[];
    source: 'workspace' | 'builtin';
}