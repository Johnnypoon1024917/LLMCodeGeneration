import React, { useState, useEffect, useRef, useMemo, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import './App.css';
// V2.1.2 spec-fix-9: ReactMarkdown wrapper with GFM (tables, task lists,
// strikethrough, autolinks) and inline mermaid rendering.
//
// Why a wrapper instead of editing each call site: there are 4
// <ReactMarkdown> invocations across this file (chat task reasoning,
// requirements display × 2, design display). All of them want the
// same plugins. Pre-configuring at import time means we never forget
// to pass them.
//
// The `components` prop overrides default element renderers. We only
// override `code` to detect language=mermaid and route to MermaidBlock;
// everything else falls through to the default. Other code blocks
// (no language, language-typescript, etc.) still render as ordinary
// preformatted code.
import BaseReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidBlock } from './components/MermaidBlock';

// Wrapper that pre-applies remarkGfm + the mermaid code-block override.
// Identical API to ReactMarkdown — drop-in replacement at every call site.
function ReactMarkdown({ children }: { children: string }) {
    return (
        <BaseReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                code(props) {
                    // ReactMarkdown's `code` prop signature:
                    //   inline?: boolean       — true for `inline`, false for fenced
                    //   className?: string     — `language-X` for fenced blocks
                    //   children?: ReactNode   — the code content
                    // We narrow these manually because react-markdown's
                    // typings have shifted across versions and a strict
                    // signature couples us tightly to one minor.
                    const { className, children: codeChildren, ...rest } = props as {
                        inline?: boolean;
                        className?: string;
                        children?: React.ReactNode;
                    };
                    const isInline = (props as { inline?: boolean }).inline;
                    const code = String(codeChildren ?? '').replace(/\n$/, '');

                    if (!isInline && className === 'language-mermaid') {
                        return <MermaidBlock chart={code} />;
                    }

                    // Default rendering for everything else (inline code,
                    // other language blocks, no-language fences). Preserve
                    // any extra props the caller might have set.
                    return (
                        <code className={className} {...rest}>
                            {codeChildren}
                        </code>
                    );
                },
            }}
        >
            {children}
        </BaseReactMarkdown>
    );
}
import { advanceAutonomyQueue, buildInitialAutonomyQueue } from './autonomyQueue';
// V2.1.2b — scaffold confirmation flow. State machine + dialog
// component live separately so the rules (when to dialog, when to
// submit) are unit-tested without React. App.tsx just wires React
// state to the reducer's side-effect flags.
import {
    reduceScaffoldDecision,
    initialScaffoldDecisionState,
    type ScaffoldDecisionState,
    type ScaffoldDecisionAction,
    type CapturedPayload,
} from './scaffoldDecisionState';
import ScaffoldConfirmationDialog from './components/ScaffoldConfirmationDialog';
import { SpecStepper, type SpecStepperPhase } from './components/SpecStepper';
import { TimelineView } from './timeline/TimelineView';
import { AttachmentPreview } from './components/AttachmentPreview';
import { extractPdfText } from './utils/pdfExtract';
import { buildAttachmentContext, type SpecAttachment } from './utils/attachmentTypes';
import {
    buildImporterIndex,
    buildNodeContext,
    type CodeGraphContextView,
    type WorkspaceGraphData,
} from './codeGraphContext';
import {
    aggregateThinkingState,
    bulkToggleFromState,
    type ThinkingModeFlags,
} from './thinkingModeState';
// M-3: ForceGraph3D pulls in three.js (~600 KB / ~150 KB gzipped).
// Lazy-load it so the chat (Vibe) tab — which most users open and
// nothing else — never pays that cost. The chunk only loads on first
// Map tab render. See views/MapGraph.tsx for the wrapper.
const MapGraph = lazy(() => import('./views/MapGraph'));
// PR 1.3: new shell layout. Rail replaces the horizontal tab bar,
// SecurityStrip is the always-visible gate-status header. The
// existing per-tab content stays unchanged for now — it's just
// rendered inside AppShell instead of the legacy app-wrapper div.
import { AppShell } from './layout/AppShell';
import { Rail } from './layout/Rail';
import { SecurityStrip, type SecurityStatus } from './layout/SecurityStrip';
// PR 2.1: Workspace view components — IdleState (empty-state) and
// Message (normal/compacted variants). Per-task plans/tool cards
// stay inline in App.tsx until PR 2.2.
import { IdleState } from './views/workspace/IdleState';
import { Message as MessageView } from './views/workspace/Message';
// PR 2.3: Bash approval card (extracted from inline JSX).
import { BashApprovalCard } from './views/workspace/BashApprovalCard';
// PR 2.4: Right panel + audit log.
import { usePanel } from './state/usePanel';
import { useAuditLog } from './state/useAuditLog';
import { AuditLogPanel } from './views/audit/AuditLogPanel';
// PR 3.1: Spec workflow — phase stepper + EARS helper.
import { PhaseStepper, type PhaseState as PhaseStateForStepper } from './views/specs/PhaseStepper';
import { EarsHelper, insertAtCursor } from './views/specs/EarsHelper';
// PR 3.2: hooks panel.
import { useHooks } from './state/useHooks';
import { HooksPanel } from './views/hooks/HooksPanel';
import { useMcp } from './state/useMcp';
import { McpPanel } from './views/mcp/McpPanel';
// P3.1 panel: diagnostics — session telemetry, token breakdown, startup phases.
import { useDiagnostics } from './state/useDiagnostics';
import { DiagnosticsPanel } from './views/diagnostics/DiagnosticsPanel';
// PR 3.3: steering rules panel.
import { useSteering } from './state/useSteering';
import { SteeringPanel } from './views/steering/SteeringPanel';
import { log } from './utils/log';
import { parseHostMessage } from './messages/protocol';
import { FileChip } from './components/FileChip';
import { ErrorBanner } from './components/ErrorBanner';
import { CommandCard } from './components/CommandCard';
import { WorkingBar } from './components/WorkingBar';
// Component 2B-4: tool-call card rendering and state management.
import { ToolCallCard } from './components/ToolCallCard';
import { ReadActivityGroup, partitionReadActivity } from './components/ReadActivityGroup';
import { HookFireCard } from './components/HookFireCard';
import { ToolApprovalCard, type ToolApprovalRequest } from './components/ToolApprovalCard';
import { FixApplicationCard } from './components/FixApplicationCard';
import { CrossTaskRegressionBanner, type RemediationTaskPayload } from './components/CrossTaskRegressionBanner';
import { VerifierAttemptsPanel, type VerifierAttempt } from './components/VerifierAttemptsPanel';
import { applyToolEvent, type ToolCallState, type ToolLifecycleEvent } from './toolEvents';
import { applyHookEvent, sortedHookFires, type HookFireState, type HookLifecycleEvent } from './hookEvents';
import {
    // Existing icons (replaces the hand-rolled SVGs below)
    User as IconUser,
    Bot as IconNexus,
    Play as IconPlay,
    Check as IconCheck,
    ArrowUp as IconUpArrow,
    Brain as IconBrain,
    Loader2 as IconLoader,
    Eye as IconEye,
    Plus as IconPlus,
    Trash2 as IconTrash,
    Search as IconSearch,
    BookOpen as IconRead,
    Code as IconCode,
    AlertTriangle as IconAlert,
    Wrench as IconWrench,
    CheckCircle as IconCheckCircle,
    Box as IconBuild,
    RotateCw as IconRefresh,
    // New icons for the emoji replacement work (T2)
    FileText as IconFile,
    ClipboardList as IconClipboard,
    Link as IconLink,
    AlertCircle as IconWarning,
    Wand2 as IconWand,
    Square as IconStop,
    RotateCcw as IconRestart,
    Sparkles as IconSparkles,
    Zap as IconZap,
    Save as IconSave,
    FlaskConical as IconFlask,
    Archive as IconArchive,
    Edit3 as IconEdit,
    ExternalLink as IconExternalLink,
    XCircle as IconXCircle,
    Undo2 as IconUndo,
    FilePen as IconFilePen
} from 'lucide-react';

const vscode = (window as any).acquireVsCodeApi();
let chatTokenBuffer = "";
let lastChatUpdate = Date.now();
let reasoningTokenBuffer = "";
let lastReasoningUpdate = Date.now();

/**
 * V2.1.2 spec-fix-12 — Bug #2: collapse runs of 3+ consecutive newlines
 * to exactly 2 (paragraph spacing) so streamed assistant messages don't
 * render with sprawling vertical whitespace.
 *
 * V2.1.2 spec-fix-14: also strip empty list items. Models with a
 * "thinking" preamble often emit lines like "- " or "* " or "1. " with
 * no content — markdown renders these as empty <li> elements that each
 * take a full line of vertical space. The screenshot showed paragraph-
 * level cleanup wasn't enough because the gaps were coming from these
 * blank bullets, not from raw newline runs.
 *
 * Inside fenced code blocks (```…```) the content is preserved verbatim
 * because Python / YAML / Makefiles / shell heredocs all care about
 * blank-line semantics. The split regex matches the full fenced block
 * (opening ``` on its own line through closing ``` on its own line), so
 * we can collapse the OUTSIDE regions and leave the INSIDE alone.
 *
 * Idempotent: applying twice produces the same result.
 */
export function collapseExcessBlankLines(text: string): string {
    const cleanOutside = (s: string): string => {
        // Step 1: strip empty list items. Match any indentation, then a
        // bullet/number marker, then optional whitespace, then end-of-
        // line. We require the line to contain ONLY the marker + whitespace.
        //
        //   "- "                  → empty bullet, drop
        //   "  * "                → indented empty bullet, drop
        //   "1. "                 → empty numbered item, drop
        //   "- foo"               → has content, KEEP
        //   "  -"                 → marker only, no trailing space, drop
        //   "    "                → whitespace-only line, leave for newline collapse
        const emptyListItemRe = /^[ \t]*(?:[-*+]|\d+\.)[ \t]*$/gm;
        let cleaned = s.replace(emptyListItemRe, '');
        // Step 2: collapse runs of 3+ newlines (which step 1 may have
        // increased by leaving bare newlines where bullets used to be).
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        return cleaned;
    };

    // Match a fenced code block: ```optional-lang\n…\n```
    // Non-greedy on the inner content, anchored on backtick lines.
    const fenceRe = /```[^\n]*\n[\s\S]*?\n```/g;
    let out = "";
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(text)) !== null) {
        const before = text.slice(lastIndex, m.index);
        out += cleanOutside(before);
        out += m[0]; // fence content unchanged
        lastIndex = m.index + m[0].length;
    }
    const tail = text.slice(lastIndex);
    out += cleanOutside(tail);
    return out;
}

/**
 * V2.1.2 spec-redesign helper: read a File as a base64 data URL.
 * Used for image attachments where we want to render an inline preview
 * without copying the file to disk. Wrapper around FileReader because
 * its API is event-based; we want a Promise.
 */
function readAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                resolve(reader.result);
            } else {
                reject(new Error('FileReader returned non-string result'));
            }
        };
        reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
        reader.readAsDataURL(file);
    });
}

/**
 * V2.1.2 spec-fix-4: client-side slug preview. Mirrors the host's
 * SpecManager.slugify() so users see the on-disk slug live as they
 * type. Critical to match exactly — if these diverge, the user sees
 * one thing in the input and a different thing in the file system.
 *
 * Rules: lowercase, replace any run of non-alphanumeric chars with
 * a single dash, strip leading/trailing dashes. Empty result becomes
 * 'main' to match the host's fallback.
 */
function slugifyForPreview(s: string): string {
    return s.toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')         // V2.1.2 spec-fix-4: collapse multiple dashes
        .replace(/^-+|-+$/g, '')     // V2.1.2 spec-fix-4: strip ALL leading/trailing
        || 'main';
}

// Exported for unit testing. Used internally by App() but the function
// is pure and string-shaped so it's testable in isolation.
//
// L-3 hardening: this function uses regex-based tag parsing because
// it's hot-path on every assistant message. A real XML parser would
// be more correct but adds 30-50KB and a parser doesn't help us much
// — the model emits these tags inconsistently, with malformed
// attributes and unclosed tags being normal. We deliberately tolerate
// malformed input by:
//
//   1. Wrapping the body in try/catch — a bad tag should not blank
//      the chat panel; degrading to "show the original text" is the
//      right failure mode.
//   2. Capping input length. Without a cap, a malformed tag in a
//      multi-megabyte stream can trigger pathological regex backtracking
//      and freeze the UI thread for seconds.
//   3. Refusing non-string input rather than crashing on .replace().
//
// Known limitations (call out explicitly so future contributors don't
// "fix" them and break working flows):
//   - Attributes containing escaped quotes (\" inside a value) will
//     truncate at the first quote. The model rarely emits these.
//   - Nested tags of the same name are not handled; the outermost
//     closing tag wins. Matches LLM output patterns we observe.
const MAX_CLEAN_INPUT = 1_000_000; // 1 MB ceiling; well above any real message
export const cleanTraceabilityTags = (text: string) => {
    // (a) Reject non-string defensively. Earlier versions assumed a
    // string and would throw a TypeError on .replace() if a malformed
    // payload arrived (e.g. {chatToken: undefined}).
    if (typeof text !== 'string' || text.length === 0) { return ''; }

    // (c) Cap input. Slicing from the start preserves the leading
    // narrative which is what the user reads first; the cut-off tail
    // is rare and tolerable as a graceful failure mode.
    const input = text.length > MAX_CLEAN_INPUT
        ? text.slice(0, MAX_CLEAN_INPUT)
        : text;

    try {
        let cleaned = input;

        // 1. Format Models & APIs using standard Markdown Headers
        cleaned = cleaned.replace(/<model\s+id="([^"]+)">/gi, '\n### 🗄️ Model: `$1`\n\n');
        cleaned = cleaned.replace(/<\/model>/gi, '\n\n');

        cleaned = cleaned.replace(/<api\s+method="([^"]+)"\s+route="([^"]+)">/gi, '\n### 🔌 `$1` `$2`\n\n');
        cleaned = cleaned.replace(/<\/api>/gi, '\n\n');

        // 2. Consolidate Responses into clean, single-line bullets (No asterisks)
        cleaned = cleaned.replace(/<response>[\s\S]*?<code>([^<]+)<\/code>[\s\S]*?<description>([^<]+)<\/description>[\s\S]*?<\/response>/gi, '- 📤 Status `$1`: $2\n');

        // 3. Format Params & Fields as minimalist code elements
        cleaned = cleaned.replace(/<(field|param)\s+([^>]+)\/?>/gi, (_match, _tag, attrs) => {
            // Each attribute extraction guarded — a malformed attribute
            // shouldn't corrupt the whole field. On miss, fall back to
            // sensible defaults so the bullet still renders.
            const nameMatch = (typeof attrs === 'string' ? attrs.match(/name="([^"]+)"/i) : null);
            const typeMatch = (typeof attrs === 'string' ? attrs.match(/type="([^"]+)"/i) : null);
            const descMatch = (typeof attrs === 'string' ? attrs.match(/description="([^"]+)"/i) : null);
            const requiredMatch = (typeof attrs === 'string' ? attrs.match(/required="([^"]+)"/i) : null);

            const name = nameMatch ? nameMatch[1] : 'unknown';
            const type = typeMatch ? typeMatch[1] : '';
            const desc = descMatch ? descMatch[1] : '';

            let reqBadge = '';
            if (requiredMatch) {
                reqBadge = requiredMatch[1] === 'true' ? ' `Required`' : ' `Optional`';
            }

            const typeStr = type ? ` (${type})` : '';
            return `- \`${name}\`${typeStr}${reqBadge} — ${desc}\n`;
        });

        // 4. Use actual Markdown sub-headers (####) instead of bolding for sections
        cleaned = cleaned.replace(/<(request)>/gi, '\n#### Request Body\n\n');
        cleaned = cleaned.replace(/<(query)>/gi, '\n#### Query Parameters\n\n');
        cleaned = cleaned.replace(/<\/(request|query)>/gi, '\n\n');

        // 5. Format descriptions as standard blockquotes
        cleaned = cleaned.replace(/<description>([^<]+)<\/description>/gi, '\n> $1\n\n');

        // 6. Strip all REMAINING invisible structural matrix tags
        cleaned = cleaned.replace(/<\/?(epic|story|criteria|metadata|target_audience|nfr_list|architecture_components|data_models|er_diagram|business_interaction|api_routes|folder_structure|tasks|task|instructions)[^>]*>/gi, '');

        // 7. Enforce strict Markdown spacing (fixes ReactMarkdown choking on lists)
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

        return cleaned.trim();
    } catch (err) {
        // (b) Catch-all: degrade to the raw input rather than blanking
        // the chat panel. Webview logger surfaces the failure for
        // diagnosis without bothering the user.
        log.warn('cleanTraceabilityTags failed; returning raw text:', err);
        return input.trim();
    }
};

interface ProjectTask {
    step: string;
    file: string;
    detailedInstructions: string;
    relatedRequirement: string;
    // V2.1.3: optional scaffold-task discriminator. Mirrors the host
    // ProjectTask shape. Webview reads this to flag scaffold tasks
    // distinctly in the plan card and to pass kind/templateId through
    // executeTask dispatch.
    kind?: 'code' | 'scaffold-template' | 'scaffold-llm';
    templateId?: string;
}

interface AIPlan {
    folderStructure: string[];
    implementationTasks: (string | ProjectTask)[];
}

interface Message {
    role: 'user' | 'assistant';
    content?: string;
    plan?: AIPlan;
    attachments?: AttachedContext[];
    isCompacted?: boolean;
    // V2.1.2 spec-fix-10 P5.2: explore-mode tracking.
    // Set when this assistant message was streamed in response to an
    // intent === 'explore' user prompt. Used to render the
    // "Apply this fix" button below the message and to send the
    // original prompt + this response back to the host on click.
    intent?: 'build' | 'explore' | 'explain' | 'ask';
    originalPrompt?: string;
    // Tracks whether the user has already clicked Apply Fix on this
    // message — once clicked, we hide the button to prevent
    // double-firing (could otherwise create two parallel build tasks
    // for the same diagnosis).
    fixApplied?: boolean;
    // V2.1.2 spec-fix-13: when this message is the SYNTHESIZED user
    // prompt that Apply Fix posts (the "re-feed"), these fields hold
    // the parts so the bubble renders compactly instead of dumping
    // the whole 19KB synthesized prompt. Absent on regular user msgs.
    isFixApplication?: boolean;
    fixApplicationOriginalPrompt?: string;
    fixApplicationDiagnosisLength?: number;
}

interface AttachedContext { file: string; code: string; language: string; }
interface AtomicEdit { filepath: string; code: string; action: 'replace' | 'append' | 'inject'; target?: string; }
interface AgentStep { type: string; description: string; details?: string; }

// V2.1.2 spec-fix-10 P5.2: heuristic — does this explore-mode response
// describe a concrete fix we could apply, or is it diagnosis-only?
//
// Two signals required (both must be true):
//   1. At least one fenced code block — `\`\`\`...\`\`\``
//      Without code, the model is just describing the problem, not
//      proposing a patch.
//   2. At least one file-path mention — `index.html`, `src/app.ts`,
//      backtick-wrapped paths, etc.
//      Without a file reference, we don't know what to edit.
//
// Both deliberately conservative. We hide the button when in doubt
// rather than hand the user a button that triggers a build task on
// thin evidence. Build tasks are expensive and visible — false
// positives would erode trust in the affordance.
function isActionableExploreFix(content: string): boolean {
    if (!content || typeof content !== 'string') { return false; }

    // Fenced code block: triple-backtick anywhere, with at least
    // some content after it. Empty fences (``` ```) don't count.
    const hasCodeBlock = /```[\s\S]+?```/.test(content);
    if (!hasCodeBlock) { return false; }

    // File path: either backtick-wrapped paths (`src/foo.ts`) or
    // bare path-like tokens with common extensions. The extension
    // list captures the languages we'd realistically generate code
    // for; expand if customers ship in less-common stacks.
    const FILE_PATH_RE = /(?:`[^`]*\.(?:ts|tsx|js|jsx|py|go|java|rs|vue|svelte|html|css|md|json|yaml|yml|sh|sql)[^`]*`)|(?:\b[\w/.-]+\.(?:ts|tsx|js|jsx|py|go|java|rs|vue|svelte|html|css|md|json|yaml|yml|sh|sql)\b)/i;
    return FILE_PATH_RE.test(content);
}

interface ApplyFixCardProps {
    originalPrompt: string;
    exploreResponse: string;
    autoApply: boolean;
    onApply: (source: 'button' | 'auto') => void;
}

/**
 * V2.1.2 spec-fix-10 P5.2: Apply this fix card.
 *
 * Two visual modes depending on the autoApply prop:
 *
 *   autoApply=false (default) — static "Apply this fix" button.
 *      User clicks → onApply('button') → host fires a build task.
 *
 *   autoApply=true (opt-in setting) — countdown card.
 *      Shows "Auto-applying in 3… 2… 1…" with a Cancel button.
 *      Auto-fires onApply('auto') when countdown reaches 0.
 *      Cancel stops the timer and falls back to the static button
 *      (in case the user changes their mind about cancelling).
 *
 * The component lives only as long as msg.fixApplied stays false.
 * Once fired, the parent sets fixApplied=true and unmounts this card
 * — preventing double-fires.
 */
function ApplyFixCard({ originalPrompt: _originalPrompt, exploreResponse: _exploreResponse, autoApply, onApply }: ApplyFixCardProps) {
    // Suppress unused-prop warnings — these are the source of truth
    // for the apply payload but the card itself doesn't need to
    // display them. The parent reads them when calling onApply.
    void _originalPrompt;
    void _exploreResponse;

    // Countdown state — only meaningful when autoApply is true.
    const [secondsLeft, setSecondsLeft] = useState<number>(3);
    const [cancelled, setCancelled] = useState<boolean>(false);

    useEffect(() => {
        if (!autoApply || cancelled) { return; }

        if (secondsLeft <= 0) {
            // Countdown complete — fire the auto-apply.
            onApply('auto');
            return;
        }

        const timer = setTimeout(() => {
            setSecondsLeft(s => s - 1);
        }, 1000);

        return () => clearTimeout(timer);
    }, [autoApply, cancelled, secondsLeft, onApply]);

    // Static button mode (autoApply off, OR user cancelled the countdown).
    if (!autoApply || cancelled) {
        return (
            <div className="nexus-apply-fix-card">
                <div className="nexus-apply-fix-label">
                    💡 The diagnosis above includes a concrete fix.
                </div>
                <button
                    className="nexus-apply-fix-button"
                    onClick={() => onApply('button')}
                    title="Route this diagnosis through the build pipeline as a coded fix"
                >
                    Apply this fix
                </button>
            </div>
        );
    }

    // Countdown mode (autoApply on, not cancelled).
    return (
        <div className="nexus-apply-fix-card nexus-apply-fix-card-auto">
            <div className="nexus-apply-fix-label">
                ⚡ Auto-applying in {secondsLeft}…
            </div>
            <button
                className="nexus-apply-fix-button-cancel"
                onClick={() => setCancelled(true)}
                title="Cancel the auto-apply. Falls back to manual button."
            >
                Cancel
            </button>
        </div>
    );
}

/**
 * Icon registry. Wraps Lucide icons in <span> nodes so consumers can drop them
 * into JSX as plain values (matching the original ad-hoc-SVG API).
 *
 * Sizing rule: 14px is the body-text icon size. The Loader uses 12 to feel
 * lighter mid-sentence; Play uses 12 because it appears alongside small
 * button labels.
 *
 * Migration note (UI Tier 1, T2): this used to be 18 hand-rolled inline
 * SVGs. We swapped to Lucide because they're maintained, accessibility-
 * aware, and tree-shaken at build (only icons we import end up in the
 * bundle).
 */
const ICON_BASE = { size: 14, strokeWidth: 2 } as const;
const Icons = {
    // Original 18 — visual parity with the previous hand-rolled set
    User: <IconUser {...ICON_BASE} />,
    Nexus: <IconNexus {...ICON_BASE} />,
    Play: <IconPlay size={12} fill="currentColor" />,
    Check: <IconCheck {...ICON_BASE} />,
    UpArrow: <IconUpArrow size={14} strokeWidth={2.5} />,
    Brain: <IconBrain {...ICON_BASE} />,
    Loader: <IconLoader size={12} className="spin" />,
    Eye: <IconEye {...ICON_BASE} />,
    Plus: <IconPlus {...ICON_BASE} />,
    Trash: <IconTrash {...ICON_BASE} />,
    Search: <IconSearch {...ICON_BASE} />,
    Read: <IconRead {...ICON_BASE} />,
    Code: <IconCode {...ICON_BASE} />,
    Alert: <IconAlert {...ICON_BASE} />,
    Wrench: <IconWrench {...ICON_BASE} />,
    CheckCircle: <IconCheckCircle {...ICON_BASE} />,
    Build: <IconBuild {...ICON_BASE} />,
    Refresh: <IconRefresh {...ICON_BASE} />,
    // New for T2 — used at emoji replacement sites
    File: <IconFile {...ICON_BASE} />,
    Clipboard: <IconClipboard {...ICON_BASE} />,
    Link: <IconLink {...ICON_BASE} />,
    Warning: <IconWarning {...ICON_BASE} />,
    Wand: <IconWand {...ICON_BASE} />,
    Stop: <IconStop size={14} fill="currentColor" />,
    Restart: <IconRestart {...ICON_BASE} />,
    Sparkles: <IconSparkles {...ICON_BASE} />,
    Zap: <IconZap {...ICON_BASE} />,
    Save: <IconSave {...ICON_BASE} />,
    Flask: <IconFlask {...ICON_BASE} />,
    Archive: <IconArchive {...ICON_BASE} />,
    Edit: <IconEdit {...ICON_BASE} />,
    ExternalLink: <IconExternalLink size={12} />,
    XCircle: <IconXCircle {...ICON_BASE} />,
    Undo: <IconUndo {...ICON_BASE} />,
    FilePen: <IconFilePen {...ICON_BASE} />
};

export default function App() {
    const { t } = useTranslation();
    const chatTokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reasoningTokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    //  MAP & TRACEABILITY STATE
    const [graphPayload, setGraphPayload] = useState<any>(null);
    const [activeMapType, setActiveMapType] = useState<'codeMap' | 'reqMap' | 'combinedMap'>('combinedMap');
    const [isGraphLoading, setIsGraphLoading] = useState<boolean>(false);

    // V2.1.2 spec-fix-6: per-spec filter for the matrix views.
    //
    // When the workspace has multiple specs, the reqMap and combinedMap can
    // get noisy fast — 5 specs × 8 epics = 40 nodes plus criteria, plus
    // file-level edges from each. The filter lets the user hide specs they
    // don't want to look at right now without re-running LLM calls (the
    // host already aggregated everything; we filter the rendered nodes
    // webview-side).
    //
    // null = "all specs visible" (default + when there's only one spec,
    // the dropdown stays hidden). A Set<string> holds the slugs the user
    // explicitly chose to include. We use Set for O(1) lookups inside
    // the visualGraphData filter.
    const [selectedSpecSlugs, setSelectedSpecSlugs] = useState<Set<string> | null>(null);
    const [showSpecFilterMenu, setShowSpecFilterMenu] = useState<boolean>(false);

    const [globalTokens, setGlobalTokens] = useState({ prompt: 0, completion: 0 });
    const [taskTokens, setTaskTokens] = useState<Record<string, { prompt: number, completion: number }>>({});

    const [taskSteps, setTaskSteps] = useState<Record<string, AgentStep[]>>({});
    // Component 2B-4a: tool-call cards state. Keyed by callId (every event
    // carries one). The reducer in toolEvents.ts handles created/updated
    // semantics. Cards are filtered + rendered by taskId matching.
    const [toolCallState, setToolCallState] = useState<Map<string, ToolCallState>>(new Map());
    // V2.1.2 spec-fix-12 — Bug #1: pending approval requests, keyed by
    // callId. Populated when host posts `requestToolApproval`; cleared
    // either when the user clicks Approve/Reject (we post the response
    // back, the host resolves its pending promise, dispatch completes,
    // and the toolCallCompleted event fires) or when the corresponding
    // tool call lands in toolCallState as completed (covers the
    // edge case where the approval was bypassed by AutoPilot mid-flight).
    const [pendingApprovals, setPendingApprovals] = useState<Map<string, ToolApprovalRequest>>(new Map());

    // V2.2 cross-task remediation: when the host detects new tsc
    // errors after a task, it posts crossTaskRegression. We render a
    // banner inline. List (not Map) because each banner is keyed on
    // sourceTaskKey + a per-event id; we rarely see more than 1-2
    // open at once.
    const [crossTaskRegressions, setCrossTaskRegressions] = useState<Array<{
        id: string;
        sourceTaskKey: string;
        newErrorCount: number;
        attributable: boolean;
        summary: string;
        remediationTask?: RemediationTaskPayload;
    }>>([]);
    // V2.2.3 "things I tried" — per-task verifier attempts with
    // structured failure data. Keyed by the backend task id we receive
    // in verifierAttempt messages (matches `data.task` from executeTask).
    // We aggregate attempts in arrival order; the panel renders them
    // chronologically. Cleared on taskRetry callback so a fresh attempt
    // doesn't visually stack on top of the previous run's panel.
    const [verifierAttemptsByTask, setVerifierAttemptsByTask] = useState<
        Map<string, VerifierAttempt[]>
    >(new Map());
    // P1.4: hook fires state. Keyed by hookFireId. The reducer in
    // hookEvents.ts handles created/updated semantics. Cards render
    // inline in the chat thread, sorted by start time.
    const [hookFireState, setHookFireState] = useState<Map<string, HookFireState>>(new Map());
    // Per-task tool-card affinity (Phase 1): maps the backend's taskId
    // (the raw approach prompt sent into runTask) to the webview's
    // taskKey ("task-3" style). Populated by the `taskExecutionStarted`
    // message that fires before each runTask invocation. Used to filter
    // cards into per-task expansion regions instead of one global list.
    //
    // Why a separate map rather than walking taskKeys: backend taskIds
    // can be very long (whole approach prompts) and contain task-
    // descriptor text. A direct hash lookup is much cheaper than scanning
    // taskKeys for each event during render.
    const [taskBackendIdToKey, setTaskBackendIdToKey] = useState<Record<string, string>>({});
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<Message[]>([]);
    const [hasKey, setHasKey] = useState<boolean>(true);
    const [loading, setLoading] = useState(false);
    const [agentStatus, setAgentStatus] = useState<string>('');
    const [codingStyle, setCodingStyle] = useState('precise');
    const codingStyleRef = useRef('precise');
    const [taskStatuses, setTaskStatuses] = useState<Record<string, string>>({});
    const [taskSummaries, setTaskSummaries] = useState<Record<string, string>>({});
    const [taskFiles, setTaskFiles] = useState<Record<string, string>>({});
    const [taskReasoning, setTaskReasoning] = useState<Record<string, string>>({});
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [selectedModel, setSelectedModel] = useState<string>('');
    const [pendingEdits, setPendingEdits] = useState<AtomicEdit[] | null>(null);
    const [metaMode, setMetaMode] = useState(false);
    const [specTimer, setSpecTimer] = useState(0);

    const [attachedContexts, setAttachedContexts] = useState<AttachedContext[]>([]);
    const [builderContexts, setBuilderContexts] = useState<AttachedContext[]>([]);
    const searchTargetRef = useRef<'coder' | 'builder'>('coder');

    const [isLoaded, setIsLoaded] = useState(false);
    const [mentionQuery, setMentionQuery] = useState('');
    const [mentionResults, setMentionResults] = useState<string[]>([]);
    const [showMentionMenu, setShowMentionMenu] = useState(false);

    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<string[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    const chatEndRef = useRef<HTMLDivElement>(null);
    const sessionStoreRef = useRef<Record<string, { messages: Message[], taskSteps: Record<string, AgentStep[]>, taskReasoning: Record<string, string> }>>({});

    const currentStateRef = useRef({ messages, taskSteps, taskReasoning });
    useEffect(() => {
        currentStateRef.current = { messages, taskSteps, taskReasoning };
    }, [messages, taskSteps, taskReasoning]);

    const [activeTab, setActiveTab] = useState<'coder' | 'builder' | 'rules' | 'Map' | 'timeline'>('coder');
    const [nexusRules, setNexusRules] = useState<string>('');
    const [requirements, setRequirements] = useState<string>('');
    // Phase-gate state (audit §11). null until first initState payload arrives.
    type PhaseStatus = 'not_started' | 'draft' | 'approved';
    interface PhaseState { requirements: PhaseStatus; design: PhaseStatus; tasks: PhaseStatus; updatedAt: string; }
    const [phaseState, setPhaseState] = useState<PhaseState | null>(null);
    const [rawIdea, setRawIdea] = useState<string>('');
    const [isGeneratingReqs, setIsGeneratingReqs] = useState(false);
    const [reqLogs, setReqLogs] = useState<string[]>([]);
    const [isEditingReqs, setIsEditingReqs] = useState(false);

    const [design, setDesign] = useState<string>('');
    const [isGeneratingDesign, setIsGeneratingDesign] = useState(false);
    const [isEditingDesign, setIsEditingDesign] = useState(false);
    const [isGeneratingTasks, setIsGeneratingTasks] = useState(false);

    // V2.1.2 spec-redesign: Stepper-related state.
    //
    // specError: the EmptyCompletionError or other failure surfaced from
    // the host. Sticks until the user retries or dismisses (no longer
    // gets blown away by generationFailed reverting the UI).
    //
    // specAttachments: list of TextAttachment / PdfAttachment / ImageAttachment.
    // Replaces the prior single-string attachment context with a structured
    // list so the preview can show per-file metadata and badges.
    const [specError, setSpecError] = useState<{ phase: 'requirements' | 'design' | 'tasks'; title: string; message: string } | null>(null);
    const [specAttachments, setSpecAttachments] = useState<SpecAttachment[]>([]);
    const specFileInputRef = useRef<HTMLInputElement>(null);

    // V2.1.2 spec-fix-4: multi-feature state.
    //
    // currentFeature mirrors the host's _currentFeature. Set initially
    // from initState's currentFeature field (defaults to 'main' for
    // existing users who never explicitly created another feature).
    //
    // featureList caches the host's view of all features in the workspace.
    // Refreshed on initState and on featureChanged messages.
    //
    // featureNameInput is what the user types in the empty-state name field.
    // The slugified preview is displayed live as they type. Empty string
    // means "use the current feature's name" (fresh install: 'main').
    const [currentFeature, setCurrentFeature] = useState<string>('main');
    const [featureList, setFeatureList] = useState<{ slug: string; phaseState: any }[]>([]);
    const [featureNameInput, setFeatureNameInput] = useState<string>('');
    const [showFeatureSwitcher, setShowFeatureSwitcher] = useState<boolean>(false);
    // V2.2 hotfix: Save & New Project dialog state. The dialog
    // prompts the user for a feature name; on submit we post
    // createFeature to the host. The current feature's content stays
    // intact on disk — just the active feature pointer switches.
    const [showSaveNewProjectDialog, setShowSaveNewProjectDialog] = useState<boolean>(false);
    const [saveNewProjectName, setSaveNewProjectName] = useState<string>('');

    // P3.1 timeline tab state. Events come in via a 'timelineEvents'
    // host message after the user clicks Refresh (or initial mount).
    // The TimelineView reduces them into a TimelineModel for display.
    // We keep raw events in App-level state so the view can re-render
    // without re-fetching when expanding/collapsing.
    const [timelineEvents, setTimelineEvents] = useState<{ type: string; [k: string]: unknown }[] | null>(null);
    const [timelineLoading, setTimelineLoading] = useState<boolean>(false);
    const [featureChangeError, setFeatureChangeError] = useState<string>('');

    /**
     * Process files dropped from the OS file picker into spec attachments.
     * Three branches by MIME type:
     *   - text/* and known code MIMEs → TextAttachment (raw text content)
     *   - application/pdf → PdfAttachment (text extracted via pdfjs)
     *   - image/* → ImageAttachment (preview only, NOT sent to LLM)
     *
     * Failures (e.g. corrupted PDF) surface as specError so the user
     * sees them — silent skips are worse than honest errors.
     */
    const handleSpecFiles = async (files: FileList | null) => {
        if (!files || files.length === 0) { return; }
        const newAttachments: SpecAttachment[] = [];

        for (const file of Array.from(files)) {
            try {
                if (file.type.startsWith('image/')) {
                    const dataUrl = await readAsDataURL(file);
                    newAttachments.push({
                        kind: 'image',
                        name: file.name,
                        dataUrl,
                        mimeType: file.type,
                        sizeBytes: file.size,
                    });
                } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
                    const buffer = await file.arrayBuffer();
                    const result = await extractPdfText(buffer);
                    newAttachments.push({
                        kind: 'pdf',
                        name: file.name,
                        extractedText: result.text,
                        pageCount: result.pageCount,
                        hasExtractableText: result.hasExtractableText,
                        thumbnailDataUrl: '', // First-page render is heavier; deferred for now
                    });
                } else {
                    // Treat everything else as text. Browsers can read most
                    // text files even when MIME is missing or generic.
                    const content = await file.text();
                    newAttachments.push({
                        kind: 'text',
                        name: file.name,
                        content,
                    });
                }
            } catch (e) {
                setSpecError({
                    phase: 'requirements',
                    title: `Could not read "${file.name}"`,
                    message: e instanceof Error ? e.message : String(e),
                });
            }
        }

        if (newAttachments.length > 0) {
            setSpecAttachments(prev => [...prev, ...newAttachments]);
        }

        // Reset the input so the same file can be re-uploaded if needed
        if (specFileInputRef.current) {
            specFileInputRef.current.value = '';
        }
    };

    const [activePlan, setActivePlan] = useState<AIPlan | null>(null);

    const [showGraph, setShowGraph] = useState(false);
    // Tightened type: nodes/edges are known properties (not index-signature
    // access), so noPropertyAccessFromIndexSignature is satisfied. The
    // remaining filename keys (e.g. "src/foo.ts") still go through the
    // index signature for older payload shapes.
    const [graphData, setGraphData] = useState<{ nodes?: any[]; edges?: any[]; [k: string]: any } | null>(null);
    // Graph granularity for the code-map view. 'file' shows
    // one node per file with edges = imports (architecture-level
    // overview). 'symbol' shows function and class nodes per file
    // (denser, useful for tracing call chains).
    //
    // Today, symbol-level data is derived from the existing FileNode
    // shape (`functions[]` / `classes[]`) — TS/JS only. v2.8 ships
    // cross-language Tree-sitter parsing + cross-file call edges +
    // semantic clustering, at which point symbol-level becomes the
    // primary view. The toggle UI is the same either way; only the
    // data fidelity behind it changes.
    const [graphGranularity, setGraphGranularity] = useState<'file' | 'symbol'>('file');
    // Right-side detail panel for the selected node. Single click on
    // a graph node populates this; double-click sends openFile to
    // the host. Null when nothing selected.
    const [selectedGraphNode, setSelectedGraphNode] = useState<{
        id: string;
        name: string;
        group: string | undefined;
        filepath?: string;
        symbol?: string;
    } | null>(null);

    const graphContainerRef = useRef<HTMLDivElement>(null);
    const [graphDims, setGraphDims] = useState({ width: 800, height: 600 });

    const [isAutopilot, setIsAutopilot] = useState(false);
    // V2.1.2 spec-fix-10 P5.2: separate toggle for explore-mode auto-apply.
    // Independent from isAutopilot (which is bash-confirmation skipping)
    // because the two operations have different blast radii — bash skip
    // affects only the in-flight task, auto-apply expands the surface
    // where edits can originate from "I asked a question."
    // Default false matches the regulated-industry positioning.
    const [autoApplyExploreFixes, setAutoApplyExploreFixes] = useState(false);

    // ─── V2.1.2b: scaffold confirmation flow ──────────────────────────
    //
    // When the user submits a chat or PRD prompt, we run a scaffold
    // pre-check first: ask the host "is this greenfield?", and if yes
    // show a dialog to pick a starter template before we let the
    // agent begin generating. The reducer in scaffoldDecisionState.ts
    // owns the rules (when to dialog, when to submit, when to drop
    // the prompt entirely on cancel). This component just executes
    // the side effects the reducer asks for.
    const [scaffoldState, setScaffoldState] =
        useState<ScaffoldDecisionState>(initialScaffoldDecisionState);

    // Single dispatcher — every action goes through here. After
    // reducing, we (a) commit the new state, (b) execute the side
    // effects flagged in the step output. Keeping this in one place
    // means we never forget to e.g. post the original payload after
    // an ack — the reducer tells us to.
    const dispatchScaffoldAction = (action: ScaffoldDecisionAction): void => {
        setScaffoldState(prev => {
            const step = reduceScaffoldDecision(prev, action);

            if (step.shouldRequestScaffoldCheck && step.state.capturedPayload) {
                const promptText = typeof step.state.capturedPayload['text'] === 'string'
                    ? step.state.capturedPayload['text'] as string
                    : '';
                vscode.postMessage({
                    type: 'requestScaffoldDecision',
                    prompt: promptText,
                });
            }

            if (step.shouldSubmitOriginal && prev.capturedPayload) {
                // Route the captured payload back to the host. The
                // payload's 'type' field is whatever the original
                // submit handler wanted (processUserMessage,
                // generateRequirements, etc.) so we just post it
                // through verbatim.
                vscode.postMessage(prev.capturedPayload);
            }

            return step.state;
        });
    };

    // ─── Execution mode (V2 phase) ─────────────────────────────────────
    //
    // Two ways to run a generated task list:
    //
    //   - 'plan'      User reviews each task; clicks Execute on each
    //                 individually. The default — matches v1's
    //                 interactive Kiro grade promise. Lowest blast
    //                 radius, ideal for compliance-sensitive customers.
    //
    //   - 'autonomy'  Once tasks are generated, the agent runs them
    //                 ALL sequentially without per-task clicks. Each
    //                 task still goes through the existing host-side
    //                 retry loop (max 2 attempts, then verifier
    //                 rejects). When Verifier rejects after retries,
    //                 the autonomy run STOPS — we don't continue past
    //                 a failed task because subsequent tasks usually
    //                 build on it and would just produce more broken
    //                 code on top.
    //
    // Future v2.6 governance: an admin portal will be able to lock
    // users into one mode. The state is intentionally a simple string
    // so an admin gate can override it without a state-shape change.
    const [executionMode, setExecutionMode] = useState<'plan' | 'autonomy'>('plan');

    // Autonomy run state. The queue is the ordered list of task keys
    // remaining to dispatch. The currently-executing task (the one
    // we're awaiting `taskCompleted` for) is NOT in the queue — it's
    // tracked via taskStatuses[key] === 'reviewing'. When taskCompleted
    // arrives with status 'approved', we shift the queue and dispatch
    // the next. With 'rejected'/'error' we clear the queue and surface
    // a banner.
    //
    // haltRef is a synchronous escape valve. The taskCompleted handler
    // runs AFTER React has scheduled a state update, so reading
    // autonomyQueue from state can race with a pending Halt click.
    // The ref gives the handler a definitive "should I dispatch the
    // next one?" answer regardless of render timing.
    const [autonomyQueue, setAutonomyQueue] = useState<string[]>([]);
    const [autonomyError, setAutonomyError] = useState<{ taskKey: string; message: string } | null>(null);
    const autonomyHaltRef = useRef<boolean>(false);

    // Thinking-mode state, mirrored from VS Code settings.
    // Default ON for all three matches the V2.0 setting defaults
    // (regulated-industry positioning prioritizes verification
    // accuracy over latency). Inline pill is a bulk toggle; per-
    // agent control is in VS Code settings (Cmd+,).
    const [thinkingMode, setThinkingMode] = useState<ThinkingModeFlags>({
        planner: true,
        coder: true,
        verifier: true,
    });

    // Mirror of the latest plan's per-task descriptors keyed by taskKey.
    // The autonomy loop dispatches tasks asynchronously after
    // `taskCompleted` events arrive — at that point it needs taskTitle
    // and prompt, but the per-task render closure (where they're
    // computed inline today) isn't available. We populate this ref
    // when the plan is rendered so the loop can look up by key.
    //
    // Why a ref not state: the lookup happens inside the message
    // handler, which would close over a stale state value. A ref
    // gives the handler the always-current snapshot. We don't render
    // off these values; we only read them inside event callbacks.
    const taskDescriptorsRef = useRef<Record<string, {
        taskTitle: string;
        prompt: string;
        kind?: 'code' | 'scaffold-template' | 'scaffold-llm';
        templateId?: string;
    }>>({});

    const [sessions, setSessions] = useState<{ id: string, name: string }[]>([{ id: '1', name: 'New Session' }]);
    const [activeSessionId, setActiveSessionId] = useState('1');

    const [terminalStreams, setTerminalStreams] = useState<Record<string, string>>({});

    const [glassBrainContext, setGlassBrainContext] = useState<string>("");
    const [pendingCommand, setPendingCommand] = useState<{ command: string, message: string } | null>(null);

    // M-8: actionable banner when the security monitor itself is
    // unreachable (vs. when it declines a command). Rendered above the
    // chat input so it's always visible while the gate is offline.
    // null = banner hidden; object = banner visible with the last
    // reported reason. Cleared by user via Retry / Disable / Dismiss.
    const [securityBanner, setSecurityBanner] = useState<{
        command: string;
        reason: string;
    } | null>(null);
    // Whether the user has disabled the gate for this session. Mirrors
    // the host-side `_securityGateEnabled` toggle so the UI knows
    // whether the banner's "Disable for session" button has been used.
    const [securityGateDisabled, setSecurityGateDisabled] = useState(false);

    // P0: pending bash_exec command awaiting user approval. Set when
    // the host posts `requestBashApproval`; cleared when the user
    // clicks Allow / Block / Allow-always. While set, renders a
    // confirmation card above the chat input — the user must click
    // before the agent loop continues. Only one prompt can be
    // pending at a time (the agent loop is single-threaded today).
    const [pendingBashApproval, setPendingBashApproval] = useState<{
        command: string;
    } | null>(null);


    useEffect(() => {
        if (!showGraph || !graphContainerRef.current) { return; }

        const resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                setGraphDims({
                    width: entry.contentRect.width,
                    height: entry.contentRect.height
                });
            }
        });

        resizeObserver.observe(graphContainerRef.current);
        return () => resizeObserver.disconnect();
    }, [showGraph]);

    //  DYNAMIC GRAPH MAPPER
    // Gracefully handles both Old AST Dictionary and New Array [{nodes, edges}] formats
    const visualGraphData = useMemo(() => {
        if (!graphData) { return { nodes: [], links: [] }; }

        const nodes: any[] = [];
        const links: any[] = [];
        const nodeSet = new Set<string>();

        // FORMAT 1: New Tracability Map (Array Form)
        if (Array.isArray(graphData.nodes) && Array.isArray(graphData.edges)) {
            const validNodeIds = new Set<string>();

            graphData.nodes.forEach((n: any) => {
                let val = 5;
                const nodeGroup = (n.group || n.type || 'file').toLowerCase();

                if (nodeGroup === 'epic') { val = 8; }
                if (nodeGroup === 'story') { val = 6; }
                if (nodeGroup === 'criteria') { val = 4; }
                if (nodeGroup === 'task') { val = 7; }

                validNodeIds.add(n.id); // Register the node ID
                nodes.push({ id: n.id, name: n.label || n.id, group: nodeGroup, val });
            });

            graphData.edges.forEach((e: any) => {
                // 🔥 FIX 2: Safely extract string IDs from mutated WebGL objects
                const sourceId = typeof e.source === 'object' ? e.source.id : String(e.source || '');
                const targetId = typeof e.target === 'object' ? e.target.id : String(e.target || '');

                // 🔥 FIX 3: FIREWALL - Only push the link if BOTH nodes actually exist!
                if (validNodeIds.has(sourceId) && validNodeIds.has(targetId)) {
                    links.push({
                        source: sourceId,
                        target: targetId,
                        color: e.color ? e.color : (sourceId.includes('Epic') || sourceId.includes('Story') || sourceId.includes('EPIC') || sourceId.includes('STORY')) ? 'rgba(245, 66, 141, 0.8)' : 'rgba(51, 154, 240, 0.9)',
                        isSemantic: e.isSemantic,
                        weight: e.weight
                    });
                } else {
                    log.warn(`[Graph Firewall] Dropped hallucinated link: ${sourceId} -> ${targetId}`);
                }
            });

            return { nodes, links };
        }

        // FORMAT 2: Fallback for Pure AST Code Map (Dictionary Form)
        // Honors graphGranularity:
        //   - 'file':   one node per file, edges = file→file imports
        //   - 'symbol': file nodes + per-file functions + classes,
        //               edges = imports + parent-of (file→symbol)
        const isSymbolLevel = graphGranularity === 'symbol';
        Object.entries(graphData).forEach(([filepath, node]: [string, any]) => {
            if (filepath === 'nodes' || filepath === 'edges') return; // Guard clause

            // (folder variable removed in tsconfig hardening — was declared but never read.)
            const filename = filepath.split('/').pop() || '';

            nodes.push({ id: filepath, name: `📄 ${filename}`, group: 'file', val: 5 });
            nodeSet.add(filepath);

            if (isSymbolLevel) {
                node.functions?.forEach((func: string) => {
                    const funcId = `${filepath}::${func}`;
                    nodes.push({ id: funcId, name: `ƒ ${func}()`, group: 'function', val: 3 });
                    links.push({ source: filepath, target: funcId, color: 'rgba(51, 154, 240, 0.9)' });
                    nodeSet.add(funcId);
                });

                node.classes?.forEach((cls: string) => {
                    const clsId = `${filepath}::${cls}`;
                    nodes.push({ id: clsId, name: `© ${cls}`, group: 'class', val: 4 });
                    links.push({ source: filepath, target: clsId, color: 'rgba(252, 163, 17, 0.9)' });
                    nodeSet.add(clsId);
                });
            }

            node.imports?.forEach((imp: string) => {
                const cleanImp = imp.replace(/['"]/g, '');
                let targetFile = Object.keys(graphData).find(k => k.includes(cleanImp.replace('./', '').replace('../', '')));
                if (targetFile) {
                    links.push({ source: filepath, target: targetFile, color: 'rgba(245, 66, 141, 0.8)' });
                }
            });
        });

        // V2.1.2 spec-fix-6: per-spec filter. When the user has hidden
        // some specs via the toolbar dropdown, drop nodes belonging to
        // those specs + the edges that would orphan as a result.
        //
        // Codepath conditions:
        //  - Only applies to reqMap and combinedMap (codeMap doesn't
        //    have a per-spec dimension; every code file is workspace-
        //    wide regardless of which spec it serves).
        //  - Only applies when selectedSpecSlugs is non-null (null = the
        //    "show all" default; no filtering needed).
        //
        // Slug detection: prefixed nodes look like "checkout-flow::EPIC-04".
        // We split on "::" and treat the first segment as the slug. Nodes
        // without "::" (raw file paths, task nodes that pre-date prefix
        // slugging) are kept regardless — they're spec-agnostic in nature.
        const filterBySpec = selectedSpecSlugs !== null && (activeMapType === 'reqMap' || activeMapType === 'combinedMap');
        if (filterBySpec) {
            const allowed = selectedSpecSlugs as Set<string>;
            const keptNodeIds = new Set<string>();
            const filteredNodes = nodes.filter(n => {
                const idx = n.id.indexOf('::');
                if (idx < 0) {
                    // No slug prefix — always keep (code files, generic tasks).
                    keptNodeIds.add(n.id);
                    return true;
                }
                const slug = n.id.substring(0, idx);
                // Heuristic: if the segment before "::" looks like a feature
                // slug we know about (it's in the user's featureList), apply
                // the filter. Otherwise the "::" is part of some other id
                // structure (e.g. a symbol-level "filepath::funcName") and
                // we keep it.
                const isFeatureSlug = featureList.some(f => f.slug === slug);
                if (!isFeatureSlug) {
                    keptNodeIds.add(n.id);
                    return true;
                }
                if (allowed.has(slug)) {
                    keptNodeIds.add(n.id);
                    return true;
                }
                return false;
            });
            const filteredLinks = links.filter(l => {
                const src = typeof l.source === 'object' ? l.source.id : String(l.source);
                const tgt = typeof l.target === 'object' ? l.target.id : String(l.target);
                return keptNodeIds.has(src) && keptNodeIds.has(tgt);
            });
            return { nodes: filteredNodes, links: filteredLinks };
        }

        return { nodes, links };
    }, [graphData, graphGranularity, selectedSpecSlugs, activeMapType, featureList]);

    // Inverse import index for the side-panel "Importers" section.
    // Forward imports (this file → those files) live on each
    // FileNode; "who imports me" requires walking the graph once
    // to build the inverse. We do that once per graph load and
    // memoize on graphData identity.
    //
    // Skipped for FORMAT-1 (traceability) graphs that come as
    // {nodes,edges} arrays — those don't have FileNode shape.
    const importerIndex = useMemo<Record<string, string[]>>(() => {
        if (!graphData || Array.isArray((graphData as any).nodes)) { return {}; }
        return buildImporterIndex(graphData as unknown as WorkspaceGraphData);
    }, [graphData]);

    // Derived 360° context for the currently-selected graph node.
    // Pure: depends on the node id, the graph dictionary, and the
    // importer index. When no node is selected, this is null and
    // the panel falls back to the existing minimal info card.
    const selectedNodeContext = useMemo<CodeGraphContextView>(() => {
        if (!selectedGraphNode || !graphData) { return null; }
        if (Array.isArray((graphData as any).nodes)) { return null; }
        return buildNodeContext(
            selectedGraphNode.id,
            graphData as unknown as WorkspaceGraphData,
            importerIndex
        );
    }, [selectedGraphNode, graphData, importerIndex]);

    useEffect(() => { codingStyleRef.current = codingStyle; }, [codingStyle]);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, terminalStreams, glassBrainContext, pendingCommand, pendingApprovals]);

    // P1.4-compaction (2026-05): when a task transitions to
    // 'reviewing' (active execution), scroll its header to the top of
    // the viewport. This addresses the user's "if the action in the
    // task are long, I need to scroll a lot to show the next task"
    // complaint. The bottom-scroll effect above keeps following the
    // chat; THIS effect ensures the user lands on the active task's
    // header when one starts running, so they always see "what's
    // running now" without manual scrolling.
    //
    // Implementation: ref tracks the previously-active task; whenever
    // a different task becomes 'reviewing', we scroll its details
    // element into view. We use querySelector against the
    // data-task-key attribute we put on <details> rather than
    // threading refs through the deeply-nested render.
    const lastActiveReviewingTaskRef = useRef<string | null>(null);
    useEffect(() => {
        // Find the active reviewing task. There's typically only one,
        // but if multiple are 'reviewing' (rare race), pick the last
        // one in entry order — that's the most recently dispatched.
        const activeKey = Object.entries(taskStatuses)
            .filter(([, s]) => s === 'reviewing')
            .map(([k]) => k)
            .pop() ?? null;
        if (activeKey === null) {
            lastActiveReviewingTaskRef.current = null;
            return;
        }
        if (activeKey === lastActiveReviewingTaskRef.current) {
            return;
        }
        lastActiveReviewingTaskRef.current = activeKey;
        // Defer to next paint so the <details> with data-task-key has
        // rendered. Without this rAF, the querySelector misses on the
        // first transition.
        requestAnimationFrame(() => {
            const el = document.querySelector(
                `details.nexus-task-card[data-task-key="${CSS.escape(activeKey)}"]`
            );
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }, [taskStatuses]);

    useEffect(() => {
        vscode.postMessage({ type: 'webviewReady' });
        vscode.postMessage({ type: 'requestModels' });
    }, []);

    useEffect(() => {
        let interval: ReturnType<typeof setTimeout>;
        if (isGeneratingReqs || isGeneratingDesign || isGeneratingTasks) {
            interval = setInterval(() => setSpecTimer(t => t + 1), 1000);
        } else {
            setSpecTimer(0);
        }
        return () => clearInterval(interval);
    }, [isGeneratingReqs, isGeneratingDesign, isGeneratingTasks]);

    const formatTime = (sec: number) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    useEffect(() => {
        if (graphPayload) {
            setGraphData(graphPayload[activeMapType] || null);
        }
    }, [activeMapType, graphPayload]);

    useEffect(() => {
        const messageHandler = (event: MessageEvent) => {
            // M-6: validate inbound host→webview messages against the
            // shared protocol. parseHostMessage returns null (and logs)
            // for unknown types, which catches drift between the host
            // and webview when a message is renamed on one side but
            // not the other. Per-branch logic below stays unchanged.
            const data = parseHostMessage(event.data);
            if (!data) { return; }

            // V2.2 hotfix #2 (2b): session replay protocol. The host
            // streams recorded events on webview connect via these
            // three message types. We re-dispatch the inner replayed
            // event through this same handler so every existing
            // branch (toolCallEvent, chatToken, structureResponse,
            // etc.) processes it as if it had arrived live.
            if (data.type === 'replayBegin') {
                console.log(`[Replay] starting: ${data.count} events`);
                return;
            }
            if (data.type === 'replayEnd') {
                console.log(`[Replay] complete`);
                return;
            }
            if (data.type === 'replayEvent' && data.event && typeof data.event === 'object') {
                // Re-dispatch the inner event. Synthesize a
                // MessageEvent so downstream handlers see the same
                // shape as a live message.
                messageHandler(new MessageEvent('message', { data: data.event }));
                return;
            }

            // P3.1: timeline data response from host. The host fetched
            // all events-*.jsonl for the active feature and passes
            // them up here. TimelineView reduces them into the model.
            if (data.type === 'timelineEvents') {
                const incoming = Array.isArray(data.events) ? data.events as { type: string; [k: string]: unknown }[] : [];
                setTimelineEvents(incoming);
                setTimelineLoading(false);
                return;
            }

            if (data.type === 'tokenUsage') {
                // Accumulate Global Tokens
                setGlobalTokens(prev => ({
                    prompt: prev.prompt + (data.usage.prompt_tokens || 0),
                    completion: prev.completion + (data.usage.completion_tokens || 0)
                }));
                // Accumulate Task Tokens
                if (data.task) {
                    setTaskTokens(prev => {
                        const current = prev[data.task] || { prompt: 0, completion: 0 };
                        return {
                            ...prev,
                            [data.task]: {
                                prompt: current.prompt + (data.usage.prompt_tokens || 0),
                                completion: current.completion + (data.usage.completion_tokens || 0)
                            }
                        };
                    });
                }
            }

            if (data.type === 'historyCompacted') {
                setMessages(data.messages);
            }

            if (data.type === 'clearTerminalStream') {
                setTerminalStreams(prev => {
                    const next = { ...prev };
                    delete next[data.task];
                    return next;
                });
            }

            if (data.type === 'streamTerminal') {
                setTerminalStreams(prev => ({
                    ...prev,
                    [data.task]: (prev[data.task] || '') + data.text
                }));
            }

            if (data.type === 'tasksGenerated') {
                setIsGeneratingTasks(false);
                // V2.1.2 spec-redesign-fix: do NOT auto-bounce to Coder tab here.
                // The user needs to see the generated tasks on the spec page first
                // and explicitly approve via the Approve Tasks button. After
                // approval, they get a "Go to Coder" button. Auto-navigation here
                // skipped the approval step entirely — the canonical bug.
            }

            // M-8: security monitor itself failed (vs. declining a command).
            // Surface as an actionable banner. Replacing any prior banner
            // is intentional — the latest failure carries the most useful
            // reason; we don't queue them.
            if (data.type === 'securityMonitorUnavailable') {
                setSecurityBanner({
                    command: typeof data.command === 'string' ? data.command : '',
                    reason: typeof data.reason === 'string' ? data.reason : 'Security Monitor unavailable.'
                });
            }

            // P0: bash_exec command awaiting user approval. Replaces any
            // prior pending approval (only one can be active at a time
            // because the agent loop is single-threaded). Stays visible
            // until the user clicks Allow / Block / Allow-always.
            if (data.type === 'requestBashApproval') {
                setPendingBashApproval({
                    command: typeof data.command === 'string' ? data.command : ''
                });
            }

            //  TRACEABILITY PAYLOAD CAPTURE

            if (data.type === 'workspaceGraphData') {
                log.debug("[DEBUG-MAP-UI] Received workspaceGraphData from backend!", data);
            }

            if (data.type === 'workspaceGraphData') {
                try {
                    const parsedPayload = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
                    log.debug("[DEBUG-MAP-UI] Successfully parsed payload:", parsedPayload);
                    setGraphPayload(parsedPayload);
                    setGraphData(parsedPayload.combinedMap || { nodes: [], edges: [] });
                    if (parsedPayload.isGraphLoading) {
                        // Force the UI to show the CodeMap while the others load
                        setActiveMapType('codeMap');
                        setGraphData(parsedPayload.codeMap || { nodes: [], edges: [] });
                        setShowGraph(true);
                    } else {
                        // When finished, default back to Combined Map
                        setActiveMapType('combinedMap');
                        setGraphData(parsedPayload.combinedMap || { nodes: [], edges: [] });
                    }
                } catch (err) {
                    log.error("[DEBUG-MAP-UI] Failed to parse incoming graph payload:", err);
                }
            }

            if (data.type === 'startRevision') {
                const { task, feedback } = data;
                setTaskStatuses(prev => ({ ...prev, [task]: 'reviewing' }));
                setTaskSummaries(prev => ({ ...prev, [task]: 'Revising based on feedback...' }));
                setTaskSteps(prev => ({ ...prev, [task]: [] }));
                setTaskReasoning(prev => ({ ...prev, [task]: '' }));
                vscode.postMessage({ type: 'executeTask', task: task, codingStyle: codingStyleRef.current, feedback: feedback });
            }

            // V2.1.2b — scaffold decision flow.
            // Both messages route into the reducer rather than mutating
            // state directly — every transition runs through one path
            // so submit / dialog / cancel side effects can't drift.
            if (data.type === 'scaffoldDecisionAvailable') {
                dispatchScaffoldAction({
                    type: 'decisionAvailable',
                    decision: {
                        isGreenfield: data.detection.isGreenfield,
                        confidence: data.detection.confidence,
                        ...(data.detection.stackHint !== undefined ? { stackHint: data.detection.stackHint } : {}),
                        templates: data.templates,
                    },
                });
            }
            if (data.type === 'scaffoldDecisionAcknowledged') {
                dispatchScaffoldAction({
                    type: 'decisionAcknowledged',
                    applyError: data.applyError ?? null,
                });
            }

            if (data.type === 'injectTerminalTask') {
                const terminalTask = data.task;
                setMessages(prev => [...prev,
                { role: 'user', content: terminalTask },
                { role: 'assistant', content: "I am analyzing your terminal crash right now. Hang tight..." }
                ]);
                setTaskStatuses(prev => ({ ...prev, [terminalTask]: 'reviewing' }));
                vscode.postMessage({ type: 'executeTask', task: terminalTask, codingStyle: codingStyleRef.current });
            }

            if (data.type === 'agentStep') {
                setTaskSteps(prev => {
                    const currentSteps = prev[data.task] || [];
                    const lastStep = currentSteps[currentSteps.length - 1];

                    // 🚀 THE UI FIX: Bundle consecutive identical steps together!
                    if (lastStep && lastStep.description === data.description && lastStep.type === data.stepType) {
                        const newSteps = [...currentSteps];
                        newSteps[newSteps.length - 1] = {
                            ...lastStep,
                            // Concat the tool executions with a clean newline
                            details: lastStep.details ? `${lastStep.details}\n${data.details}` : data.details
                        };
                        return { ...prev, [data.task]: newSteps };
                    }

                    // Otherwise, append as a brand new step card
                    return {
                        ...prev,
                        [data.task]: [...currentSteps, { type: data.stepType, description: data.description, details: data.details }]
                    };
                });
            }

            // Component 2B-4: tool-call lifecycle events from the
            // Coordinator's ReAct loop (and eventually planAgent +
            // verificationAgent). Each event mutates per-callId state
            // via applyToolEvent. Cards render from this state.
            //
            // Forward-compat: applyToolEvent silently ignores unknown
            // event types, so newer events don't crash an older bundle.
            if (data.type === 'toolCallEvent') {
                setToolCallState(prev => applyToolEvent(prev, data.event as ToolLifecycleEvent));
                // V2.1.2 spec-fix-12 — Bug #1: when a tool call completes
                // (either approved+executed or rejected+errored), drop
                // any matching approval card from pending state so it
                // doesn't linger on screen.
                const evt = data.event as ToolLifecycleEvent;
                if (evt && evt.type === 'toolCallCompleted') {
                    setPendingApprovals(prev => {
                        if (!prev.has(evt.callId)) { return prev; }
                        const next = new Map(prev);
                        next.delete(evt.callId);
                        return next;
                    });
                }
            }

            // V2.2 hotfix #4: clear stale tool-call cards from a previous
            // retry attempt. The host fires this when a task transitions
            // from attempt N to attempt N+1. Without this, retried tasks
            // accumulated read_file/list_directory/tsc cards from each
            // attempt visually stacked, making it very hard to read what
            // the current attempt was doing (production logs showed tasks
            // hitting all 5 retries with cards from every attempt still
            // visible on screen).
            //
            // Match logic: the host sends taskId in the form
            // "task-N::filepath". Coder tool cards carry exactly that
            // taskId. Verifier cards carry "task-N::verifier::filepath"
            // (different middle segment). We extract the "task-N" prefix
            // (everything before the FIRST "::") and clear every card
            // whose taskId starts with that prefix — covers both Coder
            // and Verifier sub-scopes for the task being retried.
            //
            // Also clears matching pendingApprovals: if a write_file
            // approval was hanging when the retry triggered, it belongs
            // to the dead attempt and shouldn't carry over.
            if (data.type === 'taskRetry' && typeof data.taskId === 'string') {
                const retriedFullTaskId: string = data.taskId;
                const taskPrefix = retriedFullTaskId.split('::')[0]!;
                const prefixWithSep = taskPrefix + '::';

                setToolCallState(prev => {
                    let mutated = false;
                    const next = new Map(prev);
                    for (const [callId, card] of prev) {
                        const cardTaskId = card.taskId;
                        if (cardTaskId === taskPrefix || cardTaskId.startsWith(prefixWithSep)) {
                            next.delete(callId);
                            mutated = true;
                        }
                    }
                    return mutated ? next : prev;
                });

                setPendingApprovals(prev => {
                    if (prev.size === 0) { return prev; }
                    let mutated = false;
                    const next = new Map(prev);
                    for (const [callId, req] of prev) {
                        // pendingApprovals doesn't carry taskId directly;
                        // we cross-reference the toolCallState we just
                        // mutated. Approvals whose callId no longer has
                        // a card belong to the dead attempt.
                        // (After the setToolCallState above schedules,
                        // we can't synchronously read the new state — so
                        // we trust the call we just made and conservatively
                        // keep approvals whose callId would NOT have been
                        // cleared. The check looks at the old prev map.)
                        // Simpler: just clear all approvals on retry. A
                        // mid-flight approval after retry is rare and
                        // surfaces an obvious "approve again" prompt
                        // for the new attempt's first write_file call.
                        next.delete(callId);
                        mutated = true;
                        void req; // silence unused warning
                    }
                    return mutated ? next : prev;
                });
            }

            // V2.1.2 spec-fix-12 — Bug #1: host requests user approval
            // before dispatching write_file / edit_file. The card
            // renders inline in chat; click posts approveToolCall or
            // rejectToolCall back to the host.
            if (data.type === 'requestToolApproval') {
                const req: ToolApprovalRequest = {
                    callId: String(data.callId),
                    toolName: data.toolName,
                    filepath: String(data.filepath),
                    preview: data.preview,
                };
                setPendingApprovals(prev => {
                    const next = new Map(prev);
                    next.set(req.callId, req);
                    return next;
                });
            }

            // V2.2 cross-task remediation: host detected new tsc
            // errors after a successful task. Add a banner; user
            // dismisses or clicks Fix to remove.
            if (data.type === 'crossTaskRegression') {
                setCrossTaskRegressions(prev => [
                    ...prev,
                    {
                        id: `regression-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        sourceTaskKey: String(data.sourceTaskKey),
                        newErrorCount: Number(data.newErrorCount) || 0,
                        attributable: Boolean(data.attributable),
                        summary: String(data.summary || ''),
                        remediationTask: data.remediationTask,
                    },
                ]);
            }

            // V2.2.3 "things I tried" — verifier emitted structured
            // failures during a task's retry loop. We append per-task
            // and dedupe by attempt number (host fires once per
            // attempt; a re-run from session replay would re-fire).
            if (data.type === 'verifierAttempt') {
                const taskRef = typeof data.task === 'string' ? data.task : '';
                if (!taskRef) { return; }
                const attemptNum = Number(data.attempt);
                if (!Number.isFinite(attemptNum)) { return; }
                const incoming: VerifierAttempt = {
                    attempt: attemptNum,
                    selfHealed: Boolean(data.selfHealed),
                    critique: typeof data.critique === 'string' ? data.critique : '',
                    failures: Array.isArray(data.failures)
                        ? (data.failures as VerifierAttempt['failures'])
                        : [],
                };
                setVerifierAttemptsByTask(prev => {
                    const next = new Map(prev);
                    const existing = next.get(taskRef) ?? [];
                    // Dedupe by attempt number — replay can re-fire.
                    const filtered = existing.filter(a => a.attempt !== incoming.attempt);
                    const merged = [...filtered, incoming].sort(
                        (a, b) => a.attempt - b.attempt
                    );
                    next.set(taskRef, merged);
                    return next;
                });
            }

            // V2.2.3: when a task is retried at the outer (executeTask)
            // level — i.e. the webview redispatches via dispatchTaskExecution
            // for a new run of the same plan task — the previous run's
            // verifier attempts are stale. The host already fires
            // taskRetry for the inner Coder retry boundary, but that's
            // the WRONG boundary to clear at: the outer retry is what
            // means "start over." For now we leave attempts in place
            // across inner retries (they're cumulative dead-ends, which
            // is what we want to surface) and clear only when a brand-
            // new task starts via taskExecutionStarted.
            if (data.type === 'taskExecutionStarted') {
                const taskRef = typeof (data as { task?: unknown }).task === 'string'
                    ? (data as { task: string }).task
                    : '';
                if (taskRef) {
                    setVerifierAttemptsByTask(prev => {
                        if (!prev.has(taskRef)) { return prev; }
                        const next = new Map(prev);
                        next.delete(taskRef);
                        return next;
                    });
                }
            }

            // P1.4: hook lifecycle events from HookManager. Same shape
            // as toolCallEvent but a separate state map and reducer
            // because hooks have different semantics (no taskId, no
            // arguments, no LLM-visible result).
            if (data.type === 'hookEvent') {
                setHookFireState(prev => applyHookEvent(prev, data.event as HookLifecycleEvent));
            }

            // Per-task affinity: when SidebarProvider kicks off runTask,
            // it sends this message so the webview learns the backend's
            // taskId (the raw approach prompt) and can map it to the
            // webview's taskKey for grouping incoming card events.
            if (data.type === 'taskExecutionStarted') {
                const { taskKey, backendTaskId } = data as { taskKey: string; backendTaskId: string };
                if (typeof taskKey === 'string' && typeof backendTaskId === 'string') {
                    setTaskBackendIdToKey(prev => {
                        // Idempotent: re-execution of the same task uses
                        // the same mapping.
                        if (prev[backendTaskId] === taskKey) { return prev; }
                        return { ...prev, [backendTaskId]: taskKey };
                    });
                }
            }

            if (data.type === 'searchResults') {
                const lineMatch = data.originalQuery?.match(/:\d+(?:-\d+)?$/);
                const suffix = lineMatch ? lineMatch[0] : '';
                const updatedResults = data.results.map((r: string) => r + suffix);

                setMentionResults(updatedResults);
                setSearchResults(updatedResults);
            }

            if (data.type === 'addContext') {
                if (searchTargetRef.current === 'coder') {
                    setAttachedContexts(prev => {
                        if (prev.some(c => c.file === data.file && c.code === data.code)) { return prev; }
                        return [...prev, { file: data.file, code: data.code, language: data.language }];
                    });
                    setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
                } else {
                    setBuilderContexts(prev => {
                        if (prev.some(c => c.file === data.file && c.code === data.code)) { return prev; }
                        return [...prev, { file: data.file, code: data.code, language: data.language }];
                    });
                }
                setSearchQuery('');
                setSearchResults([]);
                setIsSearching(false);
                setMentionQuery('');
                setMentionResults([]);
                setShowMentionMenu(false);
            }

            if (data.type === 'insertText') {
                setInput(prev => prev + (prev.length > 0 && !prev.endsWith('\n') ? '\n' : '') + data.text);
                setTimeout(() => {
                    const el = document.getElementById('chat-input');
                    if (el) { el.focus(); el.scrollTop = el.scrollHeight; }
                }, 100);
            }

            if (data.type === 'addUserMessageAndSubmit') {
                // V2.1.2 spec-fix-13: detect the Apply-Fix re-feed and
                // tag the message so the renderer shows a compact card
                // instead of dumping the full synthesized prompt.
                const isFixApply = Boolean(data.applySource);
                const displayContent = `${data.text}\n\n*(Attached from Editor)*\n${data.context || ''}`;
                const newMsg: Message = isFixApply
                    ? {
                        role: 'user',
                        content: data.text,
                        isFixApplication: true,
                        fixApplicationOriginalPrompt: typeof data.applyOriginalPrompt === 'string' ? data.applyOriginalPrompt : '',
                        fixApplicationDiagnosisLength: typeof data.applyDiagnosisLength === 'number' ? data.applyDiagnosisLength : 0,
                    }
                    : { role: 'user', content: displayContent };
                setMessages(prev => [...prev, newMsg]);
                setLoading(true);
                vscode.postMessage({
                    type: 'processUserMessage',
                    text: data.text,
                    context: data.context,
                    codingStyle: codingStyleRef.current,
                    autopilot: isAutopilot,
                    // V2.1.2 spec-fix-10 P5.2: optional intent override.
                    // Set when applyExploreFix re-emits via this path —
                    // forces the build pipeline without re-running
                    // determineIntent (which could misclassify a "fix"
                    // prompt back to 'explore').
                    ...(data.forceIntent ? { forceIntent: data.forceIntent } : {})
                });
            }

            if (data.type === 'initState') {
                const loadedMsgs = data.messages || [];
                setHasKey(data.hasKey);
                if (data.taskStatuses) { setTaskStatuses(data.taskStatuses); }
                if (data.taskSummaries) { setTaskSummaries(data.taskSummaries); }
                if (data.taskFiles) { setTaskFiles(data.taskFiles); }
                if (data.requirements) { setRequirements(data.requirements); }
                if (data.design) { setDesign(data.design); }
                if (data.nexusRules) { setNexusRules(data.nexusRules); }
                if (data.phaseState) { setPhaseState(data.phaseState); }

                // V2.1.2 spec-fix-4: hydrate multi-feature state.
                // Existing users land with currentFeature='main' + a
                // featureList that just contains main. If they explicitly
                // created another feature in a previous session, the
                // workspaceState restore puts them back in that one.
                if (typeof data.currentFeature === 'string') {
                    setCurrentFeature(data.currentFeature);
                }
                if (Array.isArray(data.featureList)) {
                    setFeatureList(data.featureList);
                }

                // V2.0 follow-up: inline thinking-mode toggle. The
                // host reads VS Code settings on webviewReady and
                // sends them here. If the host is older (no
                // thinkingMode key in payload), we keep the default
                // (all-on) and the inline pill stays in "🧠 ON" state.
                if (data.thinkingMode &&
                    typeof data.thinkingMode.planner === 'boolean' &&
                    typeof data.thinkingMode.coder === 'boolean' &&
                    typeof data.thinkingMode.verifier === 'boolean'
                ) {
                    setThinkingMode({
                        planner:  data.thinkingMode.planner,
                        coder:    data.thinkingMode.coder,
                        verifier: data.thinkingMode.verifier,
                    });
                }

                if (data.tasks) {
                    setActivePlan(data.tasks);
                    const hasPlan = loadedMsgs.some((m: Message) => m.plan);
                    if (!hasPlan) {
                        setMessages([...loadedMsgs, {
                            role: 'assistant',
                            content: "Welcome back! Here is your active implementation plan. You can execute tasks autonomously, or code them yourself and ask me to verify them.",
                            plan: data.tasks
                        }]);
                    } else {
                        setMessages(loadedMsgs);
                    }
                } else {
                    setMessages(loadedMsgs);
                }

                setTimeout(() => setIsLoaded(true), 100);
            }

            if (data.type === 'requestCommandApproval') {
                setPendingCommand({
                    command: data.command,
                    message: data.message
                });
            }

            if (data.type === 'requirementsUpdated' || data.type === 'requirementsGenerated') {
                setRequirements(data.text);
                if (data.type === 'requirementsGenerated') { setIsGeneratingReqs(false); }
            }

            if (data.type === 'designGenerated') {
                setDesign(data.text);
                setIsGeneratingDesign(false);
            }

            if (data.type === 'phaseStateUpdated') {
                setPhaseState(data.phaseState);
                // V2.2 hotfix #4: startOver sends an updated featureList
                // alongside the phaseState reset. Other senders of
                // phaseStateUpdated (generation completions, approvals)
                // don't include it; in those cases we leave featureList
                // alone since nothing about the directory listing changed.
                if (Array.isArray(data.featureList)) {
                    setFeatureList(data.featureList);
                }
            }

            if (data.type === 'reqStep') {
                setReqLogs(prev => [...prev, data.message]);
            }

            if (data.type === 'specError') {
                // V2.1.2 spec-redesign: error banner replaces the prior
                // "❌ Error" reqStep line that got blown away by generationFailed.
                setSpecError({
                    phase: data.phase,
                    title: data.title,
                    message: data.message,
                });
                setIsGeneratingReqs(false);
                setIsGeneratingDesign(false);
                setIsGeneratingTasks(false);
            }

            if (data.type === 'featureChanged') {
                // V2.1.2 spec-fix-4: host switched the active feature
                // (either user-initiated via setCurrentFeature, or just
                // created via createFeature). Re-hydrate everything from
                // scratch with the new feature's content.
                setCurrentFeature(data.currentFeature);
                setFeatureList(data.featureList);
                setRequirements(data.requirements || '');
                setDesign(data.design || '');
                setActivePlan(data.tasks || null);
                setPhaseState(data.phaseState);
                // Reset ephemeral state — the previous feature's drafts
                // and errors don't apply to the new feature.
                setRawIdea('');
                setReqLogs([]);
                setSpecError(null);
                setSpecAttachments([]);
                setIsEditingReqs(false);
                setIsEditingDesign(false);
                setShowFeatureSwitcher(false);
                setFeatureChangeError('');
                setFeatureNameInput('');
            }

            if (data.type === 'featureChangeFailed') {
                // Host rejected the feature switch/create. Show the reason
                // inline in the switcher / empty-state name field area.
                setFeatureChangeError(data.reason);
            }

            if (data.type === 'generationFailed') {
                setIsGeneratingReqs(false);
                setIsGeneratingDesign(false);
                setIsGeneratingTasks(false);
            }

            if (data.type === 'updateModelsList') {
                setAvailableModels(data.models);
                if (data.currentModel && data.models.includes(data.currentModel)) { setSelectedModel(data.currentModel); }
                else if (data.models.length > 0) setSelectedModel(data.models[0]);
            }

            if (data.type === 'structureResponse') {
                setActivePlan(data.value);
                setMessages(prev => [...prev, { role: 'assistant', plan: data.value }]);
                setLoading(false);
                setIsGeneratingTasks(false);
                // V2.1.2 spec-redesign-fix: do NOT auto-bounce to Coder tab.
                // See tasksGenerated handler above for the rationale —
                // user needs to approve tasks on the spec page first.
            }

            if (data.type === 'statusUpdate') { setAgentStatus(data.message); }
            if (data.type === 'reviewEdits') { setPendingEdits(data.edits); setLoading(false); }
            if (data.type === 'allTasksCompleted') {
                setPendingEdits(null);
                setMessages(prev => [...prev, { role: 'assistant', content: "✅ Atomic transaction committed successfully." }]);
                setAgentStatus('');
            }
            if (data.type === 'taskCompleted' || data.type === 'taskStatusUpdate') {
                setTaskStatuses(prev => ({ ...prev, [data.task]: data.status }));
                if (data.summary) { setTaskSummaries(prev => ({ ...prev, [data.task]: data.summary })); }
                if (data.filepath) { setTaskFiles(prev => ({ ...prev, [data.task]: data.filepath })); }
                if (data.status === 'error') { setLoading(false); }
            }

            // Autonomy mode: advance the queue when a task reaches a
            // terminal state. Only listens for `taskCompleted` (final),
            // not `taskStatusUpdate` (intermediate). The host has
            // already exhausted its 2-attempt retry by the time we get
            // here, so the status is what we have to act on.
            //
            // The decision logic lives in advanceAutonomyQueue (pure
            // module under unit test); this handler just wires it up
            // to setState and dispatch.
            if (data.type === 'taskCompleted') {
                setAutonomyQueue(prevQueue => {
                    const status = data.status as 'approved' | 'rejected' | 'error';
                    const decision = advanceAutonomyQueue({
                        prevQueue,
                        completedTask: data.task,
                        status,
                        haltRequested: autonomyHaltRef.current,
                    });

                    if (decision.action === 'ignore') {
                        return prevQueue;
                    }
                    if (decision.action === 'finish') {
                        // Queue empty; allTasksCompleted banner fires
                        // separately from the host's plan-completion
                        // path, so nothing to do here.
                        return decision.nextQueue;
                    }
                    if (decision.action === 'halt') {
                        setAutonomyError({
                            taskKey: decision.failedTask,
                            message: decision.reason === 'rejected'
                                ? 'Task was rejected after retries. Autonomy run stopped — fix this task, then resume.'
                                : 'Task failed with an error. Autonomy run stopped — see the task panel for details.',
                        });
                        return [];
                    }
                    // decision.action === 'advance'
                    const nextKey = decision.nextTaskKey;
                    const desc = taskDescriptorsRef.current[nextKey];
                    if (!desc) {
                        // Descriptor missing — should never happen
                        // because we populate it in startAutonomyRun.
                        // Bail out cleanly with an error banner.
                        setAutonomyError({
                            taskKey: nextKey,
                            message: 'Internal error: task descriptor missing for next task. Run halted.',
                        });
                        return [];
                    }
                    // Defer the dispatch one tick — React is mid-
                    // setState and we don't want our setTaskStatuses
                    // call inside dispatchTaskExecution to land in
                    // the same batch as the current update.
                    setTimeout(() => {
                        if (autonomyHaltRef.current) { return; }
                        dispatchTaskExecution(nextKey, desc.taskTitle, desc.prompt, desc.kind, desc.templateId);
                    }, 0);
                    return decision.nextQueue;
                });
            }

            if (data.type === 'streamReasoning') {
                reasoningTokenBuffer += data.token;
                if (!reasoningTokenTimerRef.current) {
                    reasoningTokenTimerRef.current = setTimeout(() => {
                        const flush = reasoningTokenBuffer;
                        reasoningTokenBuffer = "";
                        reasoningTokenTimerRef.current = null;
                        setTaskReasoning(prev => ({
                            ...prev, [data.task]: (prev[data.task] || '') + flush
                        }));
                    }, 50);
                }
            }

            if (data.type === 'glassBrain') {
                setGlassBrainContext(data.text);
            }

            if (data.type === 'startChatStream') {
                // V2.1.2 spec-fix-10 P5.2: capture intent + originalPrompt
                // from the host so the webview knows whether this
                // assistant message is an explore-mode answer (and thus
                // eligible for the Apply Fix button).
                const intent = (data.intent === 'build' || data.intent === 'explore' || data.intent === 'explain' || data.intent === 'ask')
                    ? data.intent
                    : undefined;
                const originalPrompt = typeof data.originalPrompt === 'string' ? data.originalPrompt : undefined;
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: '',
                    ...(intent ? { intent } : {}),
                    ...(originalPrompt ? { originalPrompt } : {})
                }]);
                setLoading(false);
                setGlassBrainContext("");
            }

            if (data.type === 'chatToken') {
                chatTokenBuffer += data.token;
                if (!chatTokenTimerRef.current) {
                    chatTokenTimerRef.current = setTimeout(() => {
                        const flush = chatTokenBuffer;
                        chatTokenBuffer = "";
                        chatTokenTimerRef.current = null;
                        setMessages(prev => {
                            const newMessages = [...prev];
                            const lastIdx = newMessages.length - 1;
                            const last = newMessages[lastIdx];
                            if (last && last.role === 'assistant') {
                                // V2.1.2 fix: REPLACE the message object instead
                                // of mutating it in place. P3.2 wrapped the
                                // Message component in React.memo, which does a
                                // shallow prop comparison — if the message
                                // reference doesn't change, memo skips the
                                // re-render and the streamed content stays
                                // invisible until something forces a full
                                // remount (e.g. extension host reload). Spread
                                // into a new object so memo sees a new ref.
                                //
                                // V2.1.2 spec-fix-12 — Bug #2: collapse runs
                                // of 3+ consecutive newlines down to 2 so the
                                // explore "thinking process" doesn't render
                                // with sprawling vertical whitespace. The
                                // collapse runs OUTSIDE fenced code blocks
                                // only — code formatting is sacred. We can do
                                // this safely on every flush because re-
                                // applying it is idempotent (\n\n stays \n\n).
                                const merged = (last.content || "") + flush;
                                const cleaned = collapseExcessBlankLines(merged);
                                newMessages[lastIdx] = {
                                    ...last,
                                    content: cleaned,
                                };
                            }
                            return newMessages;
                        });
                    }, 50);
                }
            }

            if (data.type === 'metaModeChanged') { setMetaMode(data.value); }
            if (data.type === 'thinkingModeChanged' &&
                data.mode &&
                typeof data.mode.planner === 'boolean' &&
                typeof data.mode.coder === 'boolean' &&
                typeof data.mode.verifier === 'boolean'
            ) {
                setThinkingMode({
                    planner:  data.mode.planner,
                    coder:    data.mode.coder,
                    verifier: data.mode.verifier,
                });
            }
            if (data.type === 'requestReview') { setInput(`Please review this code:\n\n\`\`\`\n${data.code}\n\`\`\``); }
        };
        window.addEventListener('message', messageHandler);
        return () => window.removeEventListener('message', messageHandler);
    }, [isAutopilot]); // Dependency included

    useEffect(() => {
        if (hasKey && isLoaded) {
            vscode.postMessage({
                type: 'syncHistory',
                messages: messages,
                taskStatuses: taskStatuses,
                taskSummaries: taskSummaries,
                taskFiles: taskFiles
            });
        }
    }, [messages, taskStatuses, taskSummaries, taskFiles, hasKey, isLoaded]);

    // ─── Task execution dispatch ────────────────────────────────────────
    //
    // Single helper used by BOTH the per-task Execute button and the
    // autonomy-mode loop. Resets the per-task UI state to "running"
    // and posts the executeTask message to the host. The host runs
    // its existing retry loop (max 2 attempts, then verifier rejects)
    // and emits taskCompleted when done — the autonomy loop listens
    // for that event to dispatch the next queued task.
    //
    // taskTitleForBackend / prompt come from the per-task render
    // closure when called by the inline button, OR from the
    // taskDescriptorsRef snapshot when called by the autonomy loop.
    // Either source produces identical wire shape.
    const dispatchTaskExecution = React.useCallback((
        taskKey: string,
        taskTitleForBackend: string,
        prompt: string,
        // V2.1.3: optional scaffold-task fields. When kind is set to
        // scaffold-template / scaffold-llm, the host routes via the
        // scaffold path instead of the standard CoderAgent dispatch.
        kind?: 'code' | 'scaffold-template' | 'scaffold-llm',
        templateId?: string
    ) => {
        setTaskStatuses(prev => ({ ...prev, [taskKey]: 'reviewing' }));
        setTaskSteps(prev => ({ ...prev, [taskKey]: [] }));
        setTaskReasoning(prev => ({ ...prev, [taskKey]: '' }));
        vscode.postMessage({
            type: 'executeTask',
            task: taskKey,
            taskTitle: taskTitleForBackend,
            prompt,
            codingStyle: codingStyleRef.current,
            ...(kind && kind !== 'code' ? { taskKind: kind } : {}),
            ...(templateId ? { templateId } : {}),
        });
    }, []);

    // Start (or restart) the autonomy run from the latest plan.
    // Walks the plan's tasks in order, builds the queue of pending
    // taskKeys, dispatches the first one. Subsequent ones are
    // dispatched by the taskCompleted handler.
    //
    // If the user starts an autonomy run mid-way (some tasks already
    // completed), we skip already-approved tasks. A user might do
    // this if they ran tasks 1-3 in plan mode then want autonomy for
    // the rest.
    const startAutonomyRun = React.useCallback(() => {
        // Find the latest plan-bearing message
        const planMsg = [...messages].reverse().find(m => m.plan?.implementationTasks?.length);
        if (!planMsg?.plan) { return; }

        // Build the descriptor snapshot for ALL tasks (we need them
        // even for 'approved' tasks because the user might re-run
        // them later from the plan-mode buttons). Then build the
        // queue with `buildInitialAutonomyQueue`, which skips
        // already-approved tasks (resume-from-mid-list semantics).
        const allKeys: string[] = [];
        // V2.1.3: descriptors carry the optional task kind so dispatch
        // can route scaffold tasks via the host's scaffold path.
        const descriptors: Record<string, {
            taskTitle: string;
            prompt: string;
            kind?: 'code' | 'scaffold-template' | 'scaffold-llm';
            templateId?: string;
        }> = {};
        planMsg.plan.implementationTasks.forEach((rawTask, tIdx) => {
            const isObj = typeof rawTask !== 'string';
            const taskObj = isObj ? (rawTask as ProjectTask) : null;
            const taskKey = taskObj ? `task-${tIdx}` : (rawTask as string);
            const taskTitle = taskObj ? taskObj.step : (rawTask as string);
            const taskReq = taskObj ? taskObj.relatedRequirement : '';
            const prompt = taskObj
                ? `Task: ${taskObj.step}\nTarget File: ${taskObj.file}\nRelated PRD Requirement: ${taskReq}\n\nDetailed Instructions: ${taskObj.detailedInstructions}`
                : (rawTask as string);
            const desc: typeof descriptors[string] = { taskTitle, prompt };
            if (taskObj?.kind && taskObj.kind !== 'code') {
                desc.kind = taskObj.kind;
                if (taskObj.kind === 'scaffold-template' && taskObj.templateId) {
                    desc.templateId = taskObj.templateId;
                }
            }
            descriptors[taskKey] = desc;
            allKeys.push(taskKey);
        });

        const queue = buildInitialAutonomyQueue(allKeys, taskStatuses);

        if (queue.length === 0) {
            // Nothing to do — all tasks already approved.
            setAutonomyError(null);
            return;
        }

        taskDescriptorsRef.current = descriptors;
        autonomyHaltRef.current = false;
        setAutonomyError(null);
        setAutonomyQueue(queue);

        // Dispatch the first task. Subsequent ones flow from the
        // taskCompleted handler in the message useEffect.
        const firstKey = queue[0]!;
        const desc = descriptors[firstKey]!;
        dispatchTaskExecution(firstKey, desc.taskTitle, desc.prompt, desc.kind, desc.templateId);
    }, [messages, taskStatuses, dispatchTaskExecution]);

    const haltAutonomyRun = React.useCallback(() => {
        autonomyHaltRef.current = true;
        setAutonomyQueue([]);
        // Note: we don't abort the currently-executing task. The user
        // can do that with the existing per-task abort path. This
        // halt only stops dispatching SUBSEQUENT tasks.
    }, []);

    // ─── Per-task tool-card grouping (Phase 1 affinity) ──────────────
    //
    // CRITICAL: this useMemo MUST live before the early returns below
    // (`if (!isLoaded) return ...`, `if (!hasKey) return ...`). React's
    // Rules of Hooks require all hooks to be called in the same order
    // every render — placing this useMemo after the early returns would
    // cause it to be skipped on first render (when isLoaded=false) and
    // called on subsequent renders, triggering React error #310 and a
    // blank screen. The Phase 1 hotfix corrected this placement.
    //
    // resolveTaskKey is a plain helper (no hooks of its own), but it's
    // declared here so it stays adjacent to its sole consumer below.
    const resolveTaskKey = (backendTaskId: string): string | null => {
        const baseTaskId = backendTaskId.split('::')[0] ?? backendTaskId;
        return taskBackendIdToKey[baseTaskId] ?? null;
    };

    const cardsByTaskKey = useMemo(() => {
        const groups: Record<string, ToolCallState[]> = {};
        const unscoped: ToolCallState[] = [];
        for (const card of toolCallState.values()) {
            const key = resolveTaskKey(card.taskId);
            if (key === null) {
                unscoped.push(card);
            } else {
                if (!groups[key]) { groups[key] = []; }
                groups[key]!.push(card);
            }
        }
        // V2.2 hotfix #2: composite sort key (startedAt, startSeq).
        //
        // The host-side seq counter is allocated PER taskId
        // (toolEventEmitter.ts line 71: seqByTask map). When the
        // Coder dispatches under taskId="task-0::package.json" and
        // the Verifier dispatches under
        // taskId="task-0::verifier::package.json", BOTH get seq=0
        // for their first tool call. After resolveTaskKey collapses
        // both sub-task scopes into the same UI taskKey ("task-0"),
        // their seqs collide and a sort by startSeq alone
        // interleaves them in the wrong order — the screenshot
        // showed `tsc compile` (verifier seq=0) appearing BEFORE
        // later Coder reads (coder seq=2,3,4).
        //
        // startedAt is the host-side Date.now() at emit time, which
        // is monotonic across all taskIds. Using it as the primary
        // sort key gives correct chronological order. startSeq stays
        // as a tiebreaker for tool calls dispatched in the same
        // millisecond (rare but possible on fast machines).
        const compare = (a: ToolCallState, b: ToolCallState): number => {
            if (a.startedAt !== b.startedAt) { return a.startedAt - b.startedAt; }
            return a.startSeq - b.startSeq;
        };
        for (const key of Object.keys(groups)) {
            groups[key]!.sort(compare);
        }
        unscoped.sort(compare);
        return { groups, unscoped };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [toolCallState, taskBackendIdToKey]);

    // ─────────────────────────────────────────────────────────────────
    // CRITICAL: All hooks MUST be declared above the early-return
    // guards below (`if (!isLoaded) return ...`, `if (!hasKey) return ...`).
    // If a hook is placed AFTER an early return, it gets skipped on the
    // first render (when isLoaded=false) and called on subsequent
    // renders — a Rules of Hooks violation that crashes the webview
    // (React error #310: "Rendered fewer hooks than expected").
    // ─────────────────────────────────────────────────────────────────

    // PR 2.4: panel state + audit log subscription. Both are
    // self-contained hooks; the panel state is purely UI, the audit
    // log subscribes to host messages via useEffect.
    const panel = usePanel();
    const audit = useAuditLog();

    // PR 3.1: ref for the requirements textarea so the EARS helper
    // can insert keywords at the cursor position.
    const requirementsTextareaRef = useRef<HTMLTextAreaElement>(null);

    // PR 3.2: hooks state. useHooks subscribes to hookListUpdated
    // host messages and exposes toggleHook/runHook commands.
    const hooks = useHooks(vscode);

    // PR 3.3: steering state. Same shape as useHooks.
    const steering = useSteering(vscode);

    // P2.1: MCP servers state. Same shape — subscribes to host
    // mcpStatusUpdated messages, exposes a reload action.
    const mcp = useMcp(vscode);

    // P3.1 panel: diagnostics state. Subscribes to sessionListUpdated,
    // sessionBundleUpdated, startupTimingUpdated host messages.
    const diagnostics = useDiagnostics(vscode);

    if (!isLoaded) { return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--nexus-subtext)' }}>{t("chat.loading_nexus")}</div>; }

    if (!hasKey) {
        return (
            <div className="auth-screen">
                <div className="auth-screen-card">
                    <span className="auth-screen-brand">{Icons.Nexus} NexusCode</span>
                    <h2 className="auth-screen-title">{t("onboarding.welcome_andromeda")}</h2>
                    <p className="auth-screen-subtitle">{t("onboarding.save_key_prompt")}</p>
                    <input
                        className="auth-screen-input"
                        type="password"
                        id="api-key-input"
                        placeholder="sk-proj-..."
                        autoFocus
                    />
                    <button
                        className="nexus-btn-primary nexus-btn--equal"
                        onClick={() => {
                            const val = (document.getElementById('api-key-input') as HTMLInputElement).value;
                            if (val) { vscode.postMessage({ type: 'saveApiKey', value: val }); }
                        }}
                    >
                        {t("onboarding.save_key_button")}
                    </button>
                    <div className="auth-screen-divider" />
                    <button
                        className="nexus-btn-ghost"
                        style={{ alignSelf: 'center' }}
                        onClick={() => {
                            vscode.postMessage({ type: 'saveApiKey', value: 'lm-studio' });
                        }}
                    >
                        {t("onboarding.skip_local_button")}
                    </button>
                </div>
            </div>
        );
    }

    const handleSubmit = (overrideText?: string) => {
        const text = overrideText || input;
        if ((!text.trim() && attachedContexts.length === 0) || loading) return;

        let finalQuery = text.trim() || "Please review the attached code.";
        let contextStr = "";

        if (attachedContexts.length > 0) {
            contextStr = attachedContexts.map(c => `\n\`\`\`${c.language} title="${c.file}"\n${c.code}\n\`\`\`\n`).join('');
        }

        setMessages(prev => [...prev, { role: 'user', content: finalQuery, attachments: attachedContexts }]);
        setLoading(true);

        // V2.1.2b — route through the scaffold pre-check. If the host
        // classifies this as greenfield AND we have templates, the
        // dispatcher will pause and show the confirmation dialog
        // before posting the original payload. Otherwise it submits
        // immediately. Either way, the reducer guarantees the payload
        // is exactly what we'd have posted directly.
        const chatPayload: CapturedPayload = {
            type: 'processUserMessage',
            text: finalQuery,
            context: contextStr,
            codingStyle: codingStyleRef.current,
            autopilot: isAutopilot,
            history: messages,
        };
        dispatchScaffoldAction({ type: 'userSubmitted', payload: chatPayload });

        setInput('');
        setAttachedContexts([]);
        const textarea = document.getElementById('chat-input');
        if (textarea) { textarea.style.height = 'auto'; }
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const val = e.target.value;
        setInput(val);
        e.target.style.height = 'auto';
        e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;

        const cursorPosition = e.target.selectionStart;
        const textBeforeCursor = val.substring(0, cursorPosition);
        const words = textBeforeCursor.split(/\s/);
        const lastWord = words[words.length - 1] ?? '';

        if (lastWord.startsWith('@')) {
            setShowMentionMenu(true);
            const query = lastWord.substring(1);
            setMentionQuery(query);
            vscode.postMessage({ type: 'searchFiles', query });
        } else {
            setShowMentionMenu(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
    };

    const handleClearHistory = () => {
        vscode.postMessage({ type: 'clearHistory' });

        if (activePlan) {
            setMessages([{ role: 'assistant', content: "Conversation cleared. Active Implementation Plan preserved:", plan: activePlan }]);
        } else {
            setMessages([]);
        }

        // V2.2 hotfix: do NOT clear taskSteps/taskReasoning/taskStatuses/
        // taskSummaries/taskFiles on chat clear. These represent task
        // progression state, orthogonal to chat content. Wiping them
        // meant clearing chat made the preserved plan card look like
        // a fresh plan with no progress, even though the host's
        // tasks.md / tasks.json on disk still tracked which tasks
        // were complete.
        //
        // The Start Over flow handles "true reset" by deleting the
        // spec files AND clearing all this state. clearHistory is
        // strictly chat-only now.

        sessionStoreRef.current = {};
        setSessions([{ id: '1', name: 'New Session' }]);
        setActiveSessionId('1');
    };

    const switchSession = (newId: string) => {
        if (newId === activeSessionId) { return; }

        sessionStoreRef.current[activeSessionId] = currentStateRef.current;

        const nextState = sessionStoreRef.current[newId] || {
            messages: activePlan ? [{ role: 'assistant', content: "New session started. Active Implementation Plan preserved:", plan: activePlan }] : [],
            taskSteps: {},
            taskReasoning: {}
        };

        setMessages(nextState.messages);
        setTaskSteps(nextState.taskSteps);
        setTaskReasoning(nextState.taskReasoning);
        setActiveSessionId(newId);
    };

    return (
        <>
        <AppShell
            rail={
                <Rail
                    auditPanelOpen={panel.isOpen && panel.kind === 'audit'}
                    onAuditClick={() => panel.toggle('audit')}
                    hooksPanelOpen={panel.isOpen && panel.kind === 'hooks'}
                    onHooksClick={() => panel.toggle('hooks')}
                    steeringPanelOpen={panel.isOpen && panel.kind === 'steering'}
                    onSteeringClick={() => panel.toggle('steering')}
                    mcpPanelOpen={panel.isOpen && panel.kind === 'mcp'}
                    onMcpClick={() => panel.toggle('mcp')}
                    diagnosticsPanelOpen={panel.isOpen && panel.kind === 'diagnostics'}
                    onDiagnosticsClick={() => panel.toggle('diagnostics')}
                    activeRoute={activeTab}
                    onRouteChange={(route) => {
                        setActiveTab(route);
                        // Map view: preserve the existing fetch-on-first-open
                        // behavior. PR 2.x will move this side-effect into a
                        // useViewRoute hook.
                        if (route === 'Map' && !graphPayload) {
                            vscode.postMessage({ type: 'requestWorkspaceGraph' });
                        }
                    }}
                    onSettingsClick={() => {
                        // Existing flow: open the VS Code settings UI scoped
                        // to NexusCode config. The host listens for this
                        // message and runs `workbench.action.openSettings`.
                        vscode.postMessage({ type: 'openSettings' });
                    }}
                />
            }
            securityStrip={
                <SecurityStrip
                    status={{
                        // PR 1.3: derived from the audit-fix state already
                        // present in App.tsx. PR 2.x will lift this into a
                        // useSecurityStatus hook when App.tsx is decomposed.
                        denylistActive: true,
                        // Monitor is online unless we got a
                        // securityMonitorUnavailable message AND the user
                        // hasn't dismissed/disabled it.
                        monitorOnline: !securityBanner,
                        // Confirm-on-bash flips off when the user disables
                        // the gate for the session via the banner action.
                        confirmOnBash: !securityGateDisabled,
                        // Pre-empts confirmOnBash when a bash command is
                        // currently waiting on user click.
                        awaitingApproval: pendingBashApproval !== null,
                        // PR 2.4: live from useAuditLog. The chain
                        // starts valid (no records = nothing to break) and
                        // flips to false on the first malformed record.
                        auditChainValid: audit.chainValid,
                    } satisfies SecurityStatus}
                />
            }
            panel={
                panel.isOpen && panel.kind === 'audit' ? (
                    <AuditLogPanel
                        audit={audit}
                        onClose={panel.close}
                    />
                ) : panel.isOpen && panel.kind === 'hooks' ? (
                    <HooksPanel
                        hooks={hooks}
                        onClose={panel.close}
                        onOpenHook={(id) => vscode.postMessage({ type: 'openHookFile', id })}
                    />
                ) : panel.isOpen && panel.kind === 'steering' ? (
                    <SteeringPanel
                        steering={steering}
                        onClose={panel.close}
                    />
                ) : panel.isOpen && panel.kind === 'mcp' ? (
                    <McpPanel
                        mcp={mcp}
                        onClose={panel.close}
                    />
                ) : panel.isOpen && panel.kind === 'diagnostics' ? (
                    <DiagnosticsPanel
                        diagnostics={diagnostics}
                        onClose={panel.close}
                    />
                ) : undefined
            }
        >
            {/* Meta-mode indicator. Was previously rendered in the brand
                header; the brand is now the rail logo, so meta-mode shows
                here as a thin warning bar above the canvas. */}
            {metaMode && (
                <div className="nexus-meta-mode-banner" role="status">
                    {Icons.Warning}
                    <span>SELF-EVOLUTION ACTIVE</span>
                </div>
            )}

            {/* ========================================================= */}
            {/* 💻 TAB 1: THE CODER (Chat & Execution)                      */}
            {/* ========================================================= */}
            <div style={{ display: activeTab === 'coder' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                <div className="nexus-session-tabs">
                    {sessions.map(s => (
                        <div
                            key={s.id}
                            className={`nexus-session-tab${s.id === activeSessionId ? ' active' : ''}`}
                            onClick={() => switchSession(s.id)}
                        >
                            <span className="nexus-session-tab-name">
                                <span className="nexus-session-tab-dot" aria-hidden="true"></span>
                                {s.name}
                            </span>
                            <button
                                className="nexus-session-tab-close"
                                aria-label="Close session"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (sessions.length > 1) {
                                        const newSessions = sessions.filter(session => session.id !== s.id);
                                        setSessions(newSessions);
                                        delete sessionStoreRef.current[s.id];
                                        if (activeSessionId === s.id) {
                                            const lastSession = newSessions[newSessions.length - 1];
                                            if (lastSession) {
                                                switchSession(lastSession.id);
                                            }
                                        }
                                    }
                                }}
                            >×</button>
                        </div>
                    ))}
                    <button
                        className="nexus-btn-icon"
                        title="New session"
                        onClick={() => {
                            const newId = Date.now().toString();
                            setSessions([...sessions, { id: newId, name: `Session ${sessions.length + 1}` }]);
                            switchSession(newId);
                        }}
                    >+</button>
                </div>

                <div className="chat-container" style={{ flex: 1, overflowY: 'auto' }}>
                    {messages.length === 0 && (
                        <IdleState brandIcon={Icons.Nexus} />
                    )}

                    {messages.map((msg, idx) => {
                        if (msg.isCompacted) {
                            return (
                                <MessageView
                                    key={idx}
                                    message={msg}
                                    userIcon={Icons.User}
                                    assistantIcon={Icons.Nexus}
                                    archiveIcon={Icons.Archive}
                                    fileIcon={Icons.File}
                                />
                            );
                        }

                        // V2.1.2 spec-fix-13: when the user clicks
                        // "Apply this fix", the host re-feeds a
                        // synthesized prompt that bundles the original
                        // request + the entire diagnosis. Don't render
                        // that 19KB blob as a message bubble — show a
                        // compact card instead. The diagnosis is still
                        // visible in the assistant message above; the
                        // synthesized text the LLM actually sees is
                        // unchanged.
                        if (msg.isFixApplication) {
                            return (
                                <div
                                    key={idx}
                                    className="nexus-message user"
                                    style={{ marginBottom: '12px' }}
                                >
                                    <FixApplicationCard
                                        originalPrompt={msg.fixApplicationOriginalPrompt || ''}
                                        diagnosisLength={msg.fixApplicationDiagnosisLength || 0}
                                    />
                                </div>
                            );
                        }

                        return (
                            <MessageView
                                key={idx}
                                message={msg}
                                userIcon={Icons.User}
                                assistantIcon={Icons.Nexus}
                                archiveIcon={Icons.Archive}
                                fileIcon={Icons.File}
                            >

                                {msg.plan && (
                                    <details
                                        open
                                        className="plan-card"
                                        style={{
                                            border: '1px solid var(--vscode-widget-border)',
                                            borderRadius: '6px',
                                            overflow: 'hidden',
                                            marginTop: '10px',
                                            background: 'var(--vscode-editor-background)'
                                        }}
                                    >
                                        <summary
                                            className="plan-card-header"
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                padding: '10px 15px',
                                                background: 'var(--vscode-editorGroupHeader-tabsBackground)',
                                                cursor: 'pointer',
                                                outline: 'none',
                                                userSelect: 'none',
                                                fontWeight: 'bold',
                                                borderBottom: '1px solid var(--vscode-widget-border)'
                                            }}
                                        >
                                            <span className="nexus-flex-row">{Icons.Clipboard} Master Implementation Plan</span>
                                            <span style={{ fontSize: '11px', color: 'var(--nexus-subtext)', fontWeight: 'normal' }}>
                                                {msg.plan.implementationTasks.length} Tasks (Click to fold)
                                            </span>
                                        </summary>
                                        {/* Execution-mode toolbar.
                                            Plan mode (default): user clicks Execute on each task individually.
                                            Autonomy mode: user clicks Run All; queue advances on taskCompleted.
                                            Future v2.6 governance: an admin portal will gate the available
                                            options here. The state shape is intentionally simple so an
                                            admin restriction can clamp the dropdown without refactoring.

                                            Class modifiers:
                                              - is-autonomy: autonomy mode selected (visual accent on toolbar)
                                              - is-running:  queue has tasks pending (stronger accent + pulse) */}
                                        <div
                                            className={
                                                'execution-mode-toolbar' +
                                                (executionMode === 'autonomy' ? ' is-autonomy' : '') +
                                                (autonomyQueue.length > 0 ? ' is-running' : '')
                                            }
                                        >
                                            <label
                                                htmlFor="execution-mode-select"
                                                className="execution-mode-toolbar__label"
                                            >
                                                Mode:
                                            </label>
                                            <select
                                                id="execution-mode-select"
                                                className="execution-mode-toolbar__select"
                                                value={executionMode}
                                                onChange={(e) => {
                                                    const next = e.target.value as 'plan' | 'autonomy';
                                                    // If user switches mid-run, halt the current autonomy queue
                                                    // first — they're explicitly opting out of "run them all".
                                                    if (executionMode === 'autonomy' && next === 'plan') {
                                                        haltAutonomyRun();
                                                    }
                                                    setExecutionMode(next);
                                                }}
                                                disabled={autonomyQueue.length > 0}
                                                title={autonomyQueue.length > 0
                                                    ? 'Cannot change mode while autonomy run is in progress. Click Halt first.'
                                                    : 'Choose how tasks are executed.'}
                                            >
                                                <option value="plan">Implementation Plan (review each)</option>
                                                <option value="autonomy">Autonomy (run all)</option>
                                            </select>

                                            {/* Thinking-mode pill.
                                                Bulk toggle for all three agents (planner + coder + verifier).
                                                State derived from thinkingMode flags via aggregateThinkingState:
                                                  - 'on'    🧠 Deep thinking      — all three thinking
                                                  - 'off'   ⚡ Speed mode          — all three skip thinking
                                                  - 'mixed' 🧠 Custom (some on)   — set per-agent in settings
                                                Per-agent control lives in VS Code settings; the "Advanced"
                                                link opens that settings page filtered. */}
                                            {(() => {
                                                const state = aggregateThinkingState(thinkingMode);
                                                const label =
                                                    state === 'on'    ? '🧠 Deep thinking' :
                                                    state === 'off'   ? '⚡ Speed mode' :
                                                                        '🧠 Custom (some on)';
                                                const tooltipBase =
                                                    state === 'on'    ? 'All agents (Planner, Coder, Verifier) are reasoning deeply before responding. Most accurate; slower. Click to switch all to Speed mode.' :
                                                    state === 'off'   ? 'All agents skip extended reasoning for 2-3x faster responses. Click to switch all back to Deep thinking.' :
                                                                        'Per-agent thinking customized via settings. Click to switch all to Speed mode (overrides per-agent choices).';
                                                return (
                                                    <>
                                                        <button
                                                            type="button"
                                                            className={
                                                                'execution-mode-toolbar__thinking-pill' +
                                                                (state === 'on'    ? ' is-on'    : '') +
                                                                (state === 'off'   ? ' is-off'   : '') +
                                                                (state === 'mixed' ? ' is-mixed' : '')
                                                            }
                                                            aria-pressed={state === 'on'}
                                                            title={tooltipBase}
                                                            onClick={() => {
                                                                const next = bulkToggleFromState(state);
                                                                // Optimistic local update — host will echo
                                                                // back the authoritative state via
                                                                // thinkingModeChanged, which will reconcile.
                                                                setThinkingMode(next);
                                                                vscode.postMessage({
                                                                    type: 'setThinkingMode',
                                                                    planner:  next.planner,
                                                                    coder:    next.coder,
                                                                    verifier: next.verifier,
                                                                });
                                                            }}
                                                        >
                                                            {label}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="execution-mode-toolbar__thinking-advanced"
                                                            title="Open VS Code settings to customize thinking mode per agent (Planner / Coder / Verifier independently)."
                                                            onClick={() => {
                                                                vscode.postMessage({ type: 'openThinkingSettings' });
                                                            }}
                                                        >
                                                            Advanced…
                                                        </button>
                                                    </>
                                                );
                                            })()}

                                            {executionMode === 'autonomy' && autonomyQueue.length === 0 && (
                                                <button
                                                    className="execution-mode-toolbar__run-all"
                                                    onClick={startAutonomyRun}
                                                    title="Run all remaining tasks in order. Will stop on the first task the verifier rejects after retries."
                                                >
                                                    ▶ Run All Tasks
                                                </button>
                                            )}

                                            {autonomyQueue.length > 0 && (
                                                <>
                                                    <span
                                                        className="execution-mode-toolbar__queue-counter"
                                                        aria-live="polite"
                                                    >
                                                        Running · {autonomyQueue.length} task{autonomyQueue.length === 1 ? '' : 's'} remaining
                                                    </span>
                                                    <button
                                                        className="execution-mode-toolbar__halt"
                                                        onClick={haltAutonomyRun}
                                                        title="Stop dispatching subsequent tasks. The currently-running task will finish on its own."
                                                    >
                                                        ⏸ Halt
                                                    </button>
                                                </>
                                            )}
                                        </div>

                                        {autonomyError && (
                                            <div className="execution-mode-toolbar__error-banner">
                                                <span>⏸ {autonomyError.message}</span>
                                                <button
                                                    className="execution-mode-toolbar__error-banner-dismiss"
                                                    onClick={() => setAutonomyError(null)}
                                                    title="Dismiss this banner"
                                                >Dismiss</button>
                                            </div>
                                        )}

                                        <div className="task-list" style={{ padding: '12px' }}>
                                            {msg.plan.implementationTasks.map((rawTask, tIdx) => {
                                                const isObj = typeof rawTask !== 'string';
                                                const taskObj = isObj ? (rawTask as ProjectTask) : null;

                                                // Hotfix (post-2B): the previous derivation `taskObj?.step ?? rawTask`
                                                // produced a taskKey that COLLIDED across tasks when:
                                                //   (a) the model returned multiple tasks with empty `step` (e.g.,
                                                //       17 tasks all keyed by ""), or
                                                //   (b) two tasks happened to share the same step text.
                                                // Symptom: clicking Execute on one task showed all tasks as
                                                // "running" because they all read the same dictionary entry.
                                                //
                                                // Fix: derive taskKey from the task's POSITION in the plan
                                                // (always unique). The original step text is preserved as
                                                // taskTitle (used for display) and taskTitleForBackend (sent
                                                // alongside `task: taskKey` so SpecManager.markTaskCompleted
                                                // can still sync the .nexus/specs/<feature>/tasks.md checkbox
                                                // by matching on the human-readable title).
                                                //
                                                // Plain-string tasks (legacy format) keep using the string
                                                // itself as the key — they're rare, usually unique, and
                                                // changing their behavior risks breaking older flows.
                                                const taskKey = taskObj ? `task-${tIdx}` : (rawTask as string);
                                                const taskTitle = taskObj ? taskObj.step : (rawTask as string);
                                                const taskTitleForBackend = taskTitle; // sent as `taskTitle` field
                                                const taskFile = taskObj ? taskObj.file : "";
                                                const taskReq = taskObj ? taskObj.relatedRequirement : "";

                                                const taskPrompt = taskObj
                                                    ? `Task: ${taskObj.step}\nTarget File: ${taskObj.file}\nRelated PRD Requirement: ${taskReq}\n\nDetailed Instructions: ${taskObj.detailedInstructions}`
                                                    : (rawTask as string);

                                                const status = taskStatuses[taskKey];

                                                // Autonomy queue visibility: a task is "queued"
                                                // when an autonomy run is in progress AND the
                                                // task is in the queue but not the current head.
                                                // The head is in 'reviewing' status already
                                                // (shown via the status pill); queued-after-head
                                                // tasks need a separate visual cue so the user
                                                // doesn't click their Execute buttons mid-run.
                                                const isQueuedBehindHead = autonomyQueue.length > 1 &&
                                                    autonomyQueue.indexOf(taskKey) > 0;

                                                return (
                                                    <details
                                                        key={tIdx}
                                                        className={
                                                            'nexus-task-card' +
                                                            (isQueuedBehindHead ? ' is-queued' : '')
                                                        }
                                                        data-task-key={taskKey}
                                                        data-task-status={status ?? 'pending'}
                                                        // Auto-open if not yet started or currently running.
                                                        // Behavior preserved from pre-Phase-1.5 code.
                                                        open={!status || status === 'reviewing' || status === 'error'}
                                                    >
                                                        {/* Header (always visible). Number + title on the left,
                                                            activity badge + status pill on the right. */}
                                                        <summary className="nexus-task-card-summary">
                                                            <div className="nexus-task-card-title">
                                                                <span className="nexus-task-card-number">{tIdx + 1}.</span>
                                                                <span className="nexus-task-card-title-text">{taskTitle}</span>
                                                            </div>

                                                            <div className="nexus-task-card-actions">
                                                                {/* Live activity count: shows N cards when this
                                                                    task has tool activity. Useful when the task
                                                                    is collapsed — user can see at-a-glance
                                                                    activity to look at. */}
                                                                {cardsByTaskKey.groups[taskKey] && cardsByTaskKey.groups[taskKey]!.length > 0 && (
                                                                    <span className="task-activity-badge" title={t("chat.tool_activity_count_tooltip") || "Tool calls"}>
                                                                        {cardsByTaskKey.groups[taskKey]!.length} {(cardsByTaskKey.groups[taskKey]!.length === 1) ? 'call' : 'calls'}
                                                                    </span>
                                                                )}
                                                                {/* Status pills — Phase 1.5 unifies all 5 status
                                                                    states into a single .nexus-status-pill
                                                                    vocabulary with semantic variants. Replaces
                                                                    the previous 5 distinct inline-style patterns. */}
                                                                {status === 'reviewing' && (
                                                                    <span className="nexus-status-pill reviewing">
                                                                        <span className="spin">{Icons.Loader}</span>
                                                                        {t("chat.working")}
                                                                    </span>
                                                                )}
                                                                {status === 'approved' && (
                                                                    <span className="nexus-status-pill approved">
                                                                        {Icons.CheckCircle} Approved
                                                                    </span>
                                                                )}
                                                                {status === 'rejected' && (
                                                                    <span className="nexus-status-pill rejected">
                                                                        {Icons.XCircle} Rejected
                                                                    </span>
                                                                )}
                                                                {status === 'error' && (
                                                                    <span className="nexus-status-pill error">
                                                                        {Icons.Warning} Error
                                                                    </span>
                                                                )}
                                                                {status === 'undone' && (
                                                                    <span className="nexus-status-pill reverted">
                                                                        {Icons.Undo} Reverted
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </summary>

                                                        {/* Body (collapsible). */}
                                                        <div className="nexus-task-card-body">

                                                            {/* Context & Prompts */}
                                                            <div>
                                                                {taskObj && <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontFamily: 'monospace', marginBottom: '4px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>{Icons.File} {taskFile}</div>}
                                                                {taskReq && (
                                                                    <div style={{ fontSize: '10px', color: 'var(--vscode-textLink-foreground)', fontStyle: 'italic', background: 'var(--vscode-textCodeBlock-background)', padding: '2px 6px', borderRadius: '4px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                                                        {Icons.Link} Ref: {taskReq}
                                                                    </div>
                                                                )}

                                                                {taskObj && taskObj.detailedInstructions && (
                                                                    <details style={{ marginTop: '8px', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                                                                        <summary style={{ cursor: 'pointer', outline: 'none', userSelect: 'none', fontWeight: 'bold', opacity: 0.8 }}>{t("chat.view_prompt_instructions")}</summary>
                                                                        <div style={{ marginTop: '6px', padding: '8px', borderLeft: '2px solid var(--vscode-editorIndentGuide-activeBackground)', background: 'var(--vscode-editor-inactiveSelectionBackground)', whiteSpace: 'pre-wrap', borderRadius: '0 4px 4px 0' }}>
                                                                            {taskObj.detailedInstructions}
                                                                        </div>
                                                                    </details>
                                                                )}
                                                            </div>

                                                            {/* AI Execution Steps */}
                                                            {taskSteps[taskKey] && taskSteps[taskKey].length > 0 && (
                                                                <div className="agent-steps-container" style={{ background: 'var(--vscode-input-background)', padding: '8px', borderRadius: '6px', border: '1px solid var(--vscode-input-border)' }}>
                                                                    <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--nexus-subtext)', marginBottom: '6px', textTransform: 'uppercase' }}>{t("chat.swarm_execution_logs")}</div>
                                                                    {taskSteps[taskKey].map((step, sIdx) => (
                                                                        <div key={sIdx} className="agent-step-card" style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px 8px', borderLeft: '2px solid var(--vscode-editorIndentGuide-activeBackground)', marginLeft: '4px' }}>
                                                                            <div className="agent-step-header" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                                                <span className="step-icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: step.type === 'error' ? 'var(--vscode-testing-iconFailed)' : step.type === 'success' ? 'var(--vscode-testing-iconPassed)' : step.type === 'heal' ? 'var(--vscode-charts-orange)' : 'var(--vscode-symbolIcon-propertyForeground)' }}>
                                                                                    {step.type === 'search' && Icons.Search}
                                                                                    {step.type === 'read' && Icons.Read}
                                                                                    {step.type === 'analyze' && Icons.Code}
                                                                                    {step.type === 'error' && Icons.Alert}
                                                                                    {step.type === 'heal' && Icons.Wrench}
                                                                                    {step.type === 'success' && Icons.CheckCircle}
                                                                                </span>
                                                                                <span className="step-desc" style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--vscode-foreground)' }}>{step.description}</span>
                                                                            </div>
                                                                            {step.details && (
                                                                                <div className="agent-step-details" style={{ paddingLeft: '22px', fontSize: '10.5px', color: 'var(--vscode-descriptionForeground)', whiteSpace: 'pre-wrap', lineHeight: '1.5', marginTop: '4px' }}>
                                                                                    {step.details}
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}

                                                            {/* AI Reasoning Stream.
                                                                Renders as markdown so
                                                                Coordinator status messages
                                                                ("### Attempt 1 of 2",
                                                                "✅ **Verification Passed!**")
                                                                show as headers and emphasis
                                                                rather than literal markdown
                                                                tokens. The model's natural
                                                                language reasoning tokens
                                                                are interleaved as ordinary
                                                                paragraphs, so the visual
                                                                hierarchy comes from the
                                                                Coordinator separators. */}
                                                            {taskReasoning[taskKey] && (
                                                                <details open style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '6px' }}>
                                                                    <summary style={{ cursor: 'pointer', outline: 'none', userSelect: 'none', fontSize: '11px', fontWeight: 'bold', color: 'var(--nexus-subtext)' }}>
                                                                        {Icons.Brain} View AI Reasoning
                                                                    </summary>
                                                                    <div className="reasoning-content markdown-body" style={{ marginTop: '8px', fontSize: '11px' }}>
                                                                        <ReactMarkdown>{taskReasoning[taskKey] || ''}</ReactMarkdown>
                                                                    </div>
                                                                </details>
                                                            )}

                                                            {/* Per-task tool cards (Phase 1 affinity).
                                                                Renders the cards that resolve to this
                                                                taskKey via the backend→webview taskId
                                                                mapping. Only shown when there's at
                                                                least one card; structurally identical
                                                                to the global-region rendering pre-
                                                                affinity. */}
                                                            {cardsByTaskKey.groups[taskKey] && cardsByTaskKey.groups[taskKey]!.length > 0 && (
                                                                <div className="tool-call-cards-region per-task" data-task-key={taskKey}>
                                                                    {/* P1.4-compaction (2026-05): partition
                                                                        chronological cards into groups
                                                                        (consecutive reads) and singletons
                                                                        (writes, bash_exec, etc). Reads
                                                                        collapse to a single line; writes
                                                                        keep their full ToolCallCard.

                                                                        Approval cards only attach to writes
                                                                        — reads don't go through approval
                                                                        gates so we don't need to render
                                                                        approvals inside read groups. */}
                                                                    {partitionReadActivity(cardsByTaskKey.groups[taskKey]!).map((unit, uIdx) => {
                                                                        if (unit.kind === 'group') {
                                                                            return (
                                                                                <ReadActivityGroup
                                                                                    key={`group-${uIdx}-${unit.cards[0]!.callId}`}
                                                                                    cards={unit.cards}
                                                                                />
                                                                            );
                                                                        }
                                                                        const state = unit.card;
                                                                        return (
                                                                            <React.Fragment key={state.callId}>
                                                                                <ToolCallCard state={state} />
                                                                                {/* Inline approval card —
                                                                                    only fires for write
                                                                                    tools / bash_exec. The
                                                                                    global approval region
                                                                                    below renders only
                                                                                    orphans (callIds not
                                                                                    matched here). */}
                                                                                {pendingApprovals.has(state.callId) && (
                                                                                    <ToolApprovalCard
                                                                                        request={pendingApprovals.get(state.callId)!}
                                                                                        onApprove={(callId) => {
                                                                                            vscode.postMessage({ type: 'approveToolCall', callId });
                                                                                            setPendingApprovals(prev => {
                                                                                                if (!prev.has(callId)) { return prev; }
                                                                                                const next = new Map(prev);
                                                                                                next.delete(callId);
                                                                                                return next;
                                                                                            });
                                                                                        }}
                                                                                        onReject={(callId) => {
                                                                                            vscode.postMessage({ type: 'rejectToolCall', callId });
                                                                                            setPendingApprovals(prev => {
                                                                                                if (!prev.has(callId)) { return prev; }
                                                                                                const next = new Map(prev);
                                                                                                next.delete(callId);
                                                                                                return next;
                                                                                            });
                                                                                        }}
                                                                                    />
                                                                                )}
                                                                            </React.Fragment>
                                                                        );
                                                                    })}
                                                                </div>
                                                            )}

                                                            {terminalStreams[taskKey] && (
                                                                <div style={{ marginTop: '8px' }}>
                                                                    <CommandCard
                                                                        command={taskObj ? taskObj.step : taskKey}
                                                                        output={terminalStreams[taskKey] ?? ''}
                                                                        status={
                                                                            status === 'error' ? 'error' :
                                                                            status === 'approved' ? 'success' :
                                                                            'running'
                                                                        }
                                                                    />
                                                                </div>
                                                            )}

                                                            {/* Bottom Action Bar */}
                                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', paddingTop: '10px', borderTop: '1px dashed var(--vscode-widget-border)' }}>
                                                                {taskSummaries[taskKey] ? (
                                                                    <div style={{ fontSize: '11px', color: 'var(--vscode-textLink-foreground)' }}>ℹ️ {taskSummaries[taskKey]}</div>
                                                                ) : <div />}

                                                                {/* 🚀 Render Task-Specific Tokens */}
                                                                {taskTokens[taskKey] && (
                                                                    <div style={{ fontSize: '10px', color: 'var(--nexus-subtext)', display: 'flex', gap: '8px', background: 'var(--vscode-editor-inactiveSelectionBackground)', padding: '2px 6px', borderRadius: '4px' }}>
                                                                        <span title={t("tokens.task_input")}>📥 {taskTokens[taskKey].prompt.toLocaleString()}</span>
                                                                        <span title={t("tokens.task_output")}>📤 {taskTokens[taskKey].completion.toLocaleString()}</span>
                                                                    </div>
                                                                )}

                                                                <div className="nexus-flex-block-gap-2">
                                                                    {/* 1. Approved State: Diff and Undo */}
                                                                    {status === 'approved' && taskFiles[taskKey] && (
                                                                        <>
                                                                            <button className="micro-btn" onClick={() => vscode.postMessage({ type: 'showDiff', filepath: taskFiles[taskKey] })} title={t("buttons.compare_changes")}>⚖️ Diff</button>
                                                                            <button className="micro-btn" onClick={() => vscode.postMessage({ type: 'undoTaskEdit', task: taskKey })} title={t("buttons.undo_edit")}>↩️ Undo</button>
                                                                        </>
                                                                    )}

                                                                    {/* 2. Rejected State: Allow Manual Feedback */}
                                                                    {status === 'rejected' && (
                                                                        <button className="micro-btn" onClick={() => vscode.postMessage({ type: 'requestRevision', task: taskKey, taskTitle: taskTitleForBackend, codingStyle: codingStyleRef.current })}>💬 Provide Feedback</button>
                                                                    )}

                                                                    {/* 3. Executable States: Empty, Rejected, or Error */}
                                                                    {(!status || status === 'rejected' || status === 'error') && (
                                                                        <>
                                                                            {/* Only show Verify if it has never been run */}
                                                                            {!status && (
                                                                                <button
                                                                                    className="micro-btn"
                                                                                    disabled={isQueuedBehindHead}
                                                                                    onClick={() => { setTaskStatuses(prev => ({ ...prev, [taskKey]: 'reviewing' })); setTaskSteps(prev => ({ ...prev, [taskKey]: [] })); setTaskReasoning(prev => ({ ...prev, [taskKey]: '' })); vscode.postMessage({ type: 'verifyTask', task: taskKey, taskTitle: taskTitleForBackend, prompt: taskPrompt }); }}
                                                                                    title={isQueuedBehindHead
                                                                                        ? 'Queued — autonomy run is in progress. Halt it to interact with this task manually.'
                                                                                        : t("buttons.verify_manual")}
                                                                                >👁️ Verify</button>
                                                                            )}

                                                                            {/* Main Execution / Retry Button */}
                                                                            <button
                                                                                className="micro-btn btn-primary"
                                                                                style={{ background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' }}
                                                                                disabled={isQueuedBehindHead}
                                                                                onClick={() => { dispatchTaskExecution(taskKey, taskTitleForBackend, taskPrompt, taskObj?.kind, taskObj?.templateId); }}
                                                                                title={isQueuedBehindHead
                                                                                    ? 'Queued — autonomy run is in progress. Halt it to interact with this task manually.'
                                                                                    : t("buttons.auto_execute")}
                                                                            >
                                                                                {status === 'rejected' || status === 'error' ? '▶ Retry Execution' : '▶ Execute'}
                                                                            </button>
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </div>

                                                        </div>
                                                    </details>
                                                );
                                            })}
                                        </div>
                                    </details>
                                )}
                                {msg.isCompacted ? null : null}

                                {/* V2.1.2 spec-fix-10 P5.2: Apply this fix
                                    affordance for explore-mode answers.
                                    Hidden if response isn't actionable
                                    (no code blocks / no file path) or
                                    fix has already been applied. */}
                                {msg.role === 'assistant' && msg.intent === 'explore' && !msg.fixApplied && msg.originalPrompt && msg.content && isActionableExploreFix(msg.content) && (
                                    <ApplyFixCard
                                        originalPrompt={msg.originalPrompt}
                                        exploreResponse={msg.content}
                                        autoApply={autoApplyExploreFixes}
                                        onApply={(source) => {
                                            // Mark this message as applied
                                            // BEFORE posting, so re-renders
                                            // during the host's processing
                                            // don't show a duplicate button.
                                            setMessages(prev => prev.map((m, i) => i === idx ? { ...m, fixApplied: true } : m));
                                            vscode.postMessage({
                                                type: 'applyExploreFix',
                                                originalPrompt: msg.originalPrompt!,
                                                exploreResponse: msg.content!,
                                                source,
                                            });
                                        }}
                                    />
                                )}
                            </MessageView>
                        );
                    })}

                    {Object.entries(terminalStreams).map(([key, stream]) => {
                        if (key.startsWith("Auto-Test") && stream.trim().length > 0) {
                            return (
                                <div key={key} className="nexus-message assistant" style={{ marginBottom: '15px' }}>
                                    <div className="nexus-message-header assistant" style={{ marginBottom: '8px' }}>
                                        {Icons.Nexus} NEXUS TERMINAL: {key}
                                    </div>
                                    <div style={{
                                        background: '#0d1117',
                                        padding: '10px',
                                        borderRadius: '6px',
                                        border: '1px solid #30363d',
                                        fontFamily: 'monospace',
                                        fontSize: '10.5px',
                                        color: '#c9d1d9',
                                        maxHeight: '300px',
                                        overflowY: 'auto',
                                        whiteSpace: 'pre-wrap'
                                    }}>
                                        {stream}
                                    </div>
                                </div>
                            );
                        }
                        return null;
                    })}

                    {/*
                      Per-task tool-card affinity (Phase 1):
                      Cards now render INSIDE each task's expansion via the
                      `cardsByTaskKey.groups[taskKey]` lookup. This region
                      is the FALLBACK that catches "unscoped" cards — events
                      that arrived before the `taskExecutionStarted` mapping
                      was processed (rare race condition), or cards from
                      code paths that don't go through executeTask.

                      Hidden when there are no unscoped cards.
                    */}
                    {/* V2.1.2 spec-fix-12 — Bug #1: pending approval
                        cards render inline in the chat thread when
                        AutoPilot is OFF and the agent wants to make a
                        file change. Always visible (this is a blocking
                        question, not a log line). Removes itself when
                        the user clicks Approve/Reject (and again,
                        idempotently, when the host's tool-completed
                        event arrives).

                        P1.4-compaction (2026-05): approvals whose
                        callId already has a ToolCallCard inline in a
                        task group get a SECOND approval render here.
                        That was the duplicate-card bug. We now skip
                        those — the inline approval next to its
                        ToolCallCard is the source of truth. Only
                        approvals without a matching inline card
                        (orphaned / pre-task-mapping) fall through to
                        this global region.
                    */}
                    {(() => {
                        // Build set of callIds that already render
                        // inline (in some task group). Approvals with
                        // those callIds are NOT rendered here.
                        const inlineCallIds = new Set<string>();
                        for (const groupKey of Object.keys(cardsByTaskKey.groups)) {
                            const group = cardsByTaskKey.groups[groupKey];
                            if (!group) { continue; }
                            for (const card of group) {
                                inlineCallIds.add(card.callId);
                            }
                        }
                        const orphanedApprovals = Array.from(pendingApprovals.values())
                            .filter(req => !inlineCallIds.has(req.callId));
                        if (orphanedApprovals.length === 0) { return null; }
                        return (
                            <div className="tool-approval-region" aria-label="Pending approvals">
                                {orphanedApprovals.map(req => (
                                    <ToolApprovalCard
                                        key={req.callId}
                                        request={req}
                                        onApprove={(callId) => {
                                            vscode.postMessage({ type: 'approveToolCall', callId });
                                            setPendingApprovals(prev => {
                                                if (!prev.has(callId)) { return prev; }
                                                const next = new Map(prev);
                                                next.delete(callId);
                                                return next;
                                            });
                                        }}
                                        onReject={(callId) => {
                                            vscode.postMessage({ type: 'rejectToolCall', callId });
                                            setPendingApprovals(prev => {
                                                if (!prev.has(callId)) { return prev; }
                                                const next = new Map(prev);
                                                next.delete(callId);
                                                return next;
                                            });
                                        }}
                                    />
                                ))}
                            </div>
                        );
                    })()}

                    {/* V2.2 cross-task remediation: banners shown
                        when the host detects new tsc errors after a
                        successful task. Click "Fix automatically" to
                        dispatch a synthesized remediation task; click
                        "Dismiss" to ignore. */}
                    {crossTaskRegressions.length > 0 && (
                        <div className="cross-task-regression-region" aria-label="Cross-task regressions">
                            {crossTaskRegressions.map(reg => (
                                <CrossTaskRegressionBanner
                                    key={reg.id}
                                    sourceTaskKey={reg.sourceTaskKey}
                                    newErrorCount={reg.newErrorCount}
                                    summary={reg.summary}
                                    attributable={reg.attributable}
                                    {...(reg.remediationTask ? { remediationTask: reg.remediationTask } : {})}
                                    onApplyRemediation={(rt) => {
                                        // Dispatch the remediation task through
                                        // the existing executeTask path. The host
                                        // routes it through CoderAgent like any
                                        // normal task; the synthesized prompt
                                        // contains the failure context.
                                        dispatchTaskExecution(
                                            rt.taskKey,
                                            rt.taskTitle,
                                            rt.prompt,
                                            'code',
                                        );
                                        setCrossTaskRegressions(prev => prev.filter(r => r.id !== reg.id));
                                    }}
                                    onDismiss={() => {
                                        setCrossTaskRegressions(prev => prev.filter(r => r.id !== reg.id));
                                    }}
                                />
                            ))}
                        </div>
                    )}

                    {/* V2.2.3 "things I tried" panels. One per task that
                        produced verifier failures, regardless of final
                        outcome. Self-healed attempts get amber accent;
                        terminal failures get red. Collapsed by default
                        to avoid dominating the chat thread when every
                        task has 1-2 attempts. */}
                    {verifierAttemptsByTask.size > 0 && (
                        <div className="verifier-attempts-region" aria-label="Verifier attempts">
                            {Array.from(verifierAttemptsByTask.entries()).map(([tk, attempts]) => (
                                <VerifierAttemptsPanel
                                    key={`verifier-attempts-${tk}`}
                                    taskKey={tk}
                                    attempts={attempts}
                                />
                            ))}
                        </div>
                    )}

                    {cardsByTaskKey.unscoped.length > 0 && (
                        <div className="tool-call-cards-region unscoped" aria-label="Unscoped tool activity">
                            <div className="tool-cards-region-label">
                                {t("chat.tool_activity_unscoped") || "Tool activity"}
                            </div>
                            {cardsByTaskKey.unscoped.map(state => (
                                <ToolCallCard key={state.callId} state={state} />
                            ))}
                        </div>
                    )}

                    {/* P1.4: hook fire cards. Hooks fire OUTSIDE the
                        agent task workflow (saves, schedules, manual
                        runs) so they don't go in the per-task region.
                        Renders inline in the chat thread, sorted by
                        start time, so the user sees them in the order
                        they triggered.

                        Hidden when no hooks have fired this session. */}
                    {hookFireState.size > 0 && (
                        <div className="hook-fires-region" aria-label="Hook activity">
                            <div className="tool-cards-region-label">
                                {t("hooks.activity_label") || "Hook activity"}
                            </div>
                            {sortedHookFires(hookFireState).map(state => (
                                <HookFireCard key={state.hookFireId} state={state} />
                            ))}
                        </div>
                    )}

                    {loading && !agentStatus && (
                        <div className="nexus-message assistant">
                            <div className="nexus-message-header assistant">{Icons.Nexus} NEXUS</div>
                            <div className="nexus-message-content" style={{ display: 'flex', gap: '8px', color: 'var(--nexus-subtext)' }}>
                                {Icons.Loader} Thinking...
                            </div>
                        </div>
                    )}

                    {/* 🔥 THE GLASS BRAIN: Semantic & AST Context Visualizer */}
                    {loading && glassBrainContext && (
                        <div className="glass-brain-container">
                            <details className="glass-brain-details" open>
                                <summary>
                                    {Icons.Brain} Nexus Glass Brain: Context Retrieved
                                </summary>
                                <div className="glass-brain-content">
                                    {/* We split the context by lines to apply the success 
                  styling to the mathematical RRF scores automatically. 
                */}
                                    {glassBrainContext.split('\n').map((line, i) => {
                                        if (line.includes('RRF Score:')) {
                                            const [text, score] = line.split('RRF Score:');
                                            return <div key={i}>{text} <span className="glass-brain-score">RRF: {score}</span></div>;
                                        }
                                        return <div key={i}>{line}</div>;
                                    })}
                                </div>
                            </details>
                        </div>
                    )}

                    {pendingCommand && (
                        <div className="nexus-security-card">
                            <div className="nexus-security-card-header">
                                {Icons.Alert} Security Interceptor: Action Required
                            </div>
                            <div className="nexus-security-card-body">
                                <div className="nexus-security-card-message">{pendingCommand.message}</div>
                                <code className="nexus-security-card-command">
                                    $ {pendingCommand.command}
                                </code>
                                <div className="nexus-security-card-actions">
                                    <button className="nexus-btn-primary nexus-btn--equal" onClick={() => {
                                        // 🔥 UX FIX: Wipe all old terminal streams so the new execution starts on a clean slate!
                                        setTerminalStreams({});
                                        vscode.postMessage({ type: 'approveCommand', command: pendingCommand.command });
                                        setPendingCommand(null);
                                    }}>Allow</button>
                                    <button className="nexus-btn-secondary nexus-btn--equal nexus-btn--danger" onClick={() => {
                                        setPendingCommand(null);
                                        setAgentStatus("🛑 Command blocked by user.");
                                        vscode.postMessage({ type: 'rejectCommand' });
                                    }}>Block</button>
                                </div>
                            </div>
                        </div>
                    )}

                    <div ref={chatEndRef} />
                </div>

                {agentStatus && (
                    <WorkingBar
                        status={agentStatus}
                        onCancel={() => {
                            vscode.postMessage({ type: 'cancelTask' });
                        }}
                    />
                )}

                {/* P0: bash_exec confirmation prompt. The agent loop is
                    paused waiting on the user's click; rendered above
                    the security banner so it's the most urgent thing
                    in the chat area. Three buttons:
                      - Block: deny this command, agent moves on (or
                        retries with different approach)
                      - Allow: run this command only
                      - Allow always for this task: set per-session
                        autopilot so subsequent bash_exec calls in the
                        SAME task skip the prompt. Resets at next
                        user message. */}
                {pendingBashApproval && (
                    <BashApprovalCard
                        command={pendingBashApproval.command}
                        onRespond={(mode) => {
                            vscode.postMessage({ type: 'respondBashApproval', mode });
                            setPendingBashApproval(null);
                        }}
                    />
                )}

                {/* M-8: security-monitor-unavailable banner. Renders
                    above the pending-edits dock so it's the first thing
                    the user sees after a failed gate decision. Three
                    actions: Retry (clear banner; user re-runs whatever
                    they were doing), Disable for session (skip the LLM
                    judge until VS Code restart — fail-open), Dismiss
                    (acknowledge but keep gate on). Choosing Disable
                    surfaces a follow-up confirmation in copy so the
                    user understands the security implication. */}
                {securityBanner && (
                    <div
                        className="nexus-security-banner"
                        role="alert"
                        style={{
                            margin: '8px 12px',
                            padding: '10px 12px',
                            borderRadius: 'var(--nexus-radius-md, 6px)',
                            background: 'rgba(204, 167, 0, 0.10)',
                            border: '1px solid rgba(204, 167, 0, 0.35)',
                            color: 'var(--vscode-foreground)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px'
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {Icons.Warning}
                            <strong style={{ fontSize: 'var(--nexus-text-md, 12px)' }}>
                                {t('security_banner.title') || 'Security gate offline'}
                            </strong>
                        </div>
                        <div style={{ fontSize: 'var(--nexus-text-sm, 11px)', color: 'var(--nexus-subtext)', lineHeight: 1.4 }}>
                            {t('security_banner.body') ||
                                'The Security Monitor model is not responding, so commands are being blocked by default. Retry once your model is back, switch to a different model in Settings, or disable the gate for this session.'}
                            {securityBanner.command ? (
                                <div style={{ marginTop: '4px', fontFamily: 'monospace', fontSize: 'var(--nexus-text-xs, 10px)', opacity: 0.75, wordBreak: 'break-all' }}>
                                    {t('security_banner.last_command') || 'Last blocked command'}: {securityBanner.command.substring(0, 120)}
                                    {securityBanner.command.length > 120 ? '…' : ''}
                                </div>
                            ) : null}
                        </div>
                        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                            <button
                                className="nexus-btn-secondary nexus-btn--compact"
                                onClick={() => setSecurityBanner(null)}
                            >
                                {t('security_banner.retry') || 'Retry'}
                            </button>
                            <button
                                className="nexus-btn-secondary nexus-btn--compact"
                                onClick={() => {
                                    if (securityGateDisabled) { return; }
                                    const ok = window.confirm(
                                        t('security_banner.confirm_disable') ||
                                        'Disable the security gate for this session? Commands the agent runs will execute without the LLM safety check until you reload VS Code.'
                                    );
                                    if (ok) {
                                        setSecurityGateDisabled(true);
                                        setSecurityBanner(null);
                                        vscode.postMessage({ type: 'setSecurityGate', enabled: false });
                                    }
                                }}
                                title={securityGateDisabled
                                    ? (t('security_banner.already_disabled') || 'Already disabled for this session')
                                    : (t('security_banner.disable_session') || 'Disable for this session')}
                                disabled={securityGateDisabled}
                            >
                                {securityGateDisabled
                                    ? (t('security_banner.disabled_label') || 'Gate disabled')
                                    : (t('security_banner.disable_session') || 'Disable for session')}
                            </button>
                            <button
                                className="nexus-btn-secondary nexus-btn--compact"
                                onClick={() => setSecurityBanner(null)}
                                title={t('security_banner.dismiss') || 'Dismiss'}
                            >
                                ×
                            </button>
                        </div>
                    </div>
                )}

                {pendingEdits && (
                    <div className="review-dock nexus-flex-shrink-0">
                        <div className="review-header">
                            <span className="nexus-flex-row">{Icons.Warning} Review Proposed Edits</span>
                            <span style={{ cursor: 'pointer', color: 'var(--nexus-subtext)' }} onClick={() => setPendingEdits(null)}>×</span>
                        </div>
                        <div style={{ maxHeight: '80px', overflowY: 'auto' }}>
                            {pendingEdits.map((edit, i) => (
                                <div key={i} className="review-file">
                                    <span className="nexus-flex-row">{Icons.File} {edit.filepath}</span>
                                    <span style={{ color: 'var(--nexus-border)' }}>({edit.action})</span>
                                </div>
                            ))}
                        </div>
                        <div className="review-actions">
                            <button className="nexus-btn-primary nexus-btn--compact" onClick={() => { setLoading(true); setAgentStatus("Committing..."); vscode.postMessage({ type: 'commitAtomicEdits', edits: pendingEdits }); }}>✅ Commit All</button>
                            <button className="nexus-btn-secondary nexus-btn--compact" onClick={() => setPendingEdits(null)}>{t("common.cancel")}</button>
                        </div>
                    </div>
                )}

                <div className="nexus-input-shell">
                    <div className={`nexus-input-composer${metaMode ? ' meta-active' : ''}`}>
                        {attachedContexts.length > 0 && (
                            <div className="context-chips">
                                {attachedContexts.map((ctx, idx) => (
                                    <FileChip
                                        key={idx}
                                        filepath={ctx.file}
                                        language={ctx.language}
                                        title={ctx.code}
                                        onRemove={() => setAttachedContexts(prev => prev.filter((_, i) => i !== idx))}
                                    />
                                ))}
                            </div>
                        )}

                        {showMentionMenu && mentionResults.length > 0 && (
                            <div className="mention-menu">
                                <div className="mention-header">{t("mention.attach_file_context")}</div>
                                {mentionResults.map(res => (
                                    <div key={res} className="mention-item" onClick={() => {
                                        vscode.postMessage({ type: 'readFileContext', file: res });
                                        setShowMentionMenu(false);
                                        const words = input.split(' ');
                                        words.pop();
                                        setInput(words.join(' ') + (words.length > 0 ? ' ' : ''));
                                        document.getElementById('chat-input')?.focus();
                                    }}>
                                        <span className="nexus-flex-row">{Icons.File} {res}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        <textarea
                            className="nexus-input-textarea"
                            id="chat-input" value={input} onChange={handleInput} onKeyDown={handleKeyDown}
                            placeholder={metaMode ? t("chat.input.placeholder_meta_mode") : t("chat.input.placeholder")}
                            rows={1}
                        />

                        {loading ? (
                            <button
                                className="nexus-send-button stop"
                                onClick={() => { setLoading(false); vscode.postMessage({ type: 'cancelTask' }); }}
                                title={t("buttons.stop_generation")}
                            >■</button>
                        ) : (
                            <button
                                className="nexus-send-button"
                                onClick={() => handleSubmit()}
                                disabled={!input.trim() && attachedContexts.length === 0}
                                title="Send"
                            >{Icons.UpArrow}</button>
                        )}
                    </div>

                    <div className="micro-toolbar">
                        <div className="toolbar-group">
                            <select className="micro-select" value={selectedModel} onChange={(e) => { setSelectedModel(e.target.value); vscode.postMessage({ type: 'setModel', value: e.target.value }); }}>
                                {availableModels.length === 0 && <option value="">{t("common.loading")}</option>}
                                {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
                            </select>

                            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: isAutopilot ? 'var(--vscode-terminal-ansiMagenta)' : 'var(--nexus-subtext)', cursor: 'pointer', fontWeight: isAutopilot ? 'bold' : 'normal', marginLeft: '8px' }}>
                                <div style={{
                                    width: '24px', height: '14px', borderRadius: '10px', background: isAutopilot ? 'var(--vscode-terminal-ansiMagenta)' : 'var(--vscode-input-background)',
                                    position: 'relative', transition: '0.2s'
                                }}>
                                    <div style={{
                                        width: '10px', height: '10px', borderRadius: '50%', background: 'white',
                                        position: 'absolute', top: '2px', left: isAutopilot ? '12px' : '2px', transition: '0.2s'
                                    }}></div>
                                </div>
                                <input
                                    type="checkbox"
                                    checked={isAutopilot}
                                    onChange={(e) => setIsAutopilot(e.target.checked)}
                                    style={{ display: 'none' }}
                                />
                                Autopilot
                            </label>

                            {/* V2.1.2 spec-fix-10 P5.2: Auto-apply explore fixes.
                                Independent from Autopilot — different blast radius.
                                When ON, Apply Fix buttons that appear under explore-mode
                                answers auto-fire after a 3s countdown (with cancel option). */}
                            <label
                                style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: autoApplyExploreFixes ? 'var(--vscode-charts-blue, #4a90e2)' : 'var(--nexus-subtext)', cursor: 'pointer', fontWeight: autoApplyExploreFixes ? 'bold' : 'normal', marginLeft: '8px' }}
                                title="When ON, fixes diagnosed by explore mode auto-apply after a 3s countdown (cancellable). Default OFF — click 'Apply this fix' below explore answers to apply manually."
                            >
                                <div style={{
                                    width: '24px', height: '14px', borderRadius: '10px', background: autoApplyExploreFixes ? 'var(--vscode-charts-blue, #4a90e2)' : 'var(--vscode-input-background)',
                                    position: 'relative', transition: '0.2s'
                                }}>
                                    <div style={{
                                        width: '10px', height: '10px', borderRadius: '50%', background: 'white',
                                        position: 'absolute', top: '2px', left: autoApplyExploreFixes ? '12px' : '2px', transition: '0.2s'
                                    }}></div>
                                </div>
                                <input
                                    type="checkbox"
                                    checked={autoApplyExploreFixes}
                                    onChange={(e) => setAutoApplyExploreFixes(e.target.checked)}
                                    style={{ display: 'none' }}
                                />
                                Auto-Apply
                            </label>
                        </div>

                        <div className="toolbar-group" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--vscode-charts-orange)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.9, padding: 0 }}
                                onClick={() => vscode.postMessage({ type: 'generateAndRunTests', autopilot: isAutopilot })}
                                title={t("buttons.auto_run_tests")}>
                                Auto-Test
                            </button>

                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--vscode-testing-iconPassed)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.9, padding: 0 }}
                                onClick={() => vscode.postMessage({ type: 'runGlobalCompiler' })}
                                title={t("buttons.strict_compile")}>
                                {Icons.Build} Compile
                            </button>
                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--vscode-foreground)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.7, padding: 0 }}
                                onClick={handleClearHistory}
                                title={t("buttons.clear_chat")}>
                                {Icons.Trash} Clear
                            </button>
                            {/* V2.2 hotfix: Export Session button.
                                Sends current chat messages + task state
                                to the host, which bundles them with on-
                                disk specs + event log + audit info into
                                a single JSON file under .nexus/exports/
                                and opens it in a new editor tab. */}
                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--vscode-foreground)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.7, padding: 0 }}
                                onClick={() => {
                                    vscode.postMessage({
                                        type: 'exportSession',
                                        messages,
                                        taskStatuses,
                                        taskSummaries,
                                        taskFiles,
                                        taskSteps,
                                        taskReasoning,
                                        activePlan,
                                    });
                                }}
                                title="Export this session (chat + specs + tasks + event log) as JSON for sharing">
                                ⬇ Export
                            </button>
                            {/* V2.2 hotfix: Restore Plan button. Re-
                                injects the active plan card into chat
                                if it's been dismissed or scrolled past
                                in a long session. Renders only when
                                there's a plan to restore AND the most
                                recent message isn't already a plan card
                                (avoids duplicate adds).

                                This is a webview-only operation — no
                                host roundtrip needed. activePlan is
                                already in React state. */}
                            {activePlan && activePlan.implementationTasks && activePlan.implementationTasks.length > 0 &&
                             messages.length > 0 &&
                             !(messages[messages.length - 1]?.plan) && (
                                <button
                                    className="micro-btn"
                                    style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--vscode-foreground)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.7, padding: 0 }}
                                    onClick={() => {
                                        setMessages(prev => [
                                            ...prev,
                                            { role: 'assistant', content: 'Active Implementation Plan (restored):', plan: activePlan }
                                        ]);
                                    }}
                                    title="Re-inject the active plan card into chat">
                                    📋 Restore Plan
                                </button>
                            )}
                            <button
                                className="micro-btn"
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-foreground)', background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.7, padding: 0 }}
                                onClick={() => vscode.postMessage({ type: 'refreshCodeLens' })}
                                title={t("buttons.refresh_ui")}>
                                {Icons.Refresh}
                            </button>

                            {/* 🚀 Render Global Tokens */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', color: 'var(--nexus-subtext)', borderLeft: '1px solid var(--vscode-widget-border)', paddingLeft: '8px', marginLeft: '4px' }}>
                                <span title={t("tokens.total_input")}>📥 {globalTokens.prompt.toLocaleString()}</span>
                                <span title={t("tokens.total_output")}>📤 {globalTokens.completion.toLocaleString()}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ========================================================= */}
            {/* 📋 TAB 2: THE REQUIREMENT HUB (BUILDER)                   */}
            {/* ========================================================= */}
            <div className="nexus-spec-view" style={{ display: activeTab === 'builder' ? 'flex' : 'none' }}>
                {/* PR 3.1: phase stepper. Renders only when phaseState
                    has been hydrated from initState — before that there's
                    nothing meaningful to show. The stepper sits sticky at
                    the top of the spec column.

                    V2.1.2 spec-redesign: hide this top stepper while the
                    bottom SpecStepper is showing (during generation OR when
                    there's a sticky error). The two trackers serve different
                    purposes — top tracks approval state, bottom tracks live
                    generation — but stacking them looked redundant. The
                    bottom one is the more informative view during action,
                    so it wins; the top one resumes its role once generation
                    completes and the user is looking at draft/approved state. */}
                {phaseState && !(isGeneratingReqs || isGeneratingDesign || isGeneratingTasks || specError) && (
                    <PhaseStepper state={phaseState as PhaseStateForStepper} />
                )}

                {(!requirements || requirements.trim() === '') && !isGeneratingReqs && (
                    <div className="nexus-spec-intro">
                        <h3 className="nexus-spec-intro-title">{t("project.start_new")}</h3>
                        <p className="nexus-spec-intro-description">{t("project.describe_idea")}</p>

                        {/* V2.1.2 spec-fix-10: "View an existing spec" affordance.
                            Renders only when the workspace has at least one
                            existing feature. Re-uses the existing feature
                            switcher's menu component pattern — clicking a
                            feature fires setCurrentFeature, which loads that
                            feature's PRD/design/tasks into the same pretty
                            layout used everywhere else.

                            The previous UX gap: the regular switcher pill
                            (top right of the spec view) was only rendered
                            when `requirements` was non-empty. From the empty
                            state, users had no discoverable way to view an
                            old spec without clicking through to a different
                            feature first. This section closes that gap. */}
                        {/* V2.2 hotfix #4: filter out empty features from the
                            "View existing spec" picker.

                            Background: when the user clicks "Start Over" on a
                            feature, the host deletes requirements.md/design.md/
                            tasks.md/tasks.json BUT leaves the feature directory
                            and its phaseState.json on disk. The feature still
                            shows up in featureList, so it appeared in this
                            picker as a clickable item — but clicking it loaded
                            empty content and just showed the empty state again.

                            A "real" feature has at least requirements drafted
                            (status 'draft' or 'approved'). All three phases
                            being 'pending' means nothing was ever saved (or
                            startOver wiped everything). Hide those.

                            Defensive: if phaseState is missing/malformed, we
                            treat as empty and hide. Safer than showing a
                            feature we can't introspect. */}
                        {(() => {
                            const hasContent = (f: { phaseState?: { requirements?: string; design?: string; tasks?: string } }): boolean => {
                                const ps = f.phaseState;
                                if (!ps) { return false; }
                                return ps.requirements !== 'pending'
                                    || ps.design !== 'pending'
                                    || ps.tasks !== 'pending';
                            };
                            const realFeatures = featureList.filter(hasContent);
                            if (realFeatures.length === 0) { return null; }
                            return (
                                <div className="nexus-spec-existing-bar">
                                    <div className="nexus-feature-switcher">
                                        <button
                                            className="nexus-spec-existing-button"
                                            onClick={() => setShowFeatureSwitcher(v => !v)}
                                        >
                                            📂 View an existing spec ({realFeatures.length}) ▾
                                        </button>
                                        {showFeatureSwitcher && (
                                            <div className="nexus-feature-switcher-menu" onMouseLeave={() => setShowFeatureSwitcher(false)}>
                                                {realFeatures.map(f => (
                                                    <button
                                                        key={f.slug}
                                                        className={`nexus-feature-switcher-item${f.slug === currentFeature ? ' active' : ''}`}
                                                        onClick={() => {
                                                            if (f.slug !== currentFeature) {
                                                                vscode.postMessage({ type: 'setCurrentFeature', slug: f.slug });
                                                            }
                                                            setShowFeatureSwitcher(false);
                                                        }}
                                                    >
                                                        <span>{f.slug === currentFeature ? '● ' : '  '}{f.slug}</span>
                                                        <span className="nexus-feature-switcher-status">
                                                            {f.phaseState?.tasks === 'approved'
                                                                ? '✅ ready'
                                                                : f.phaseState?.tasks === 'draft'
                                                                ? '📝 tasks'
                                                                : f.phaseState?.design === 'approved'
                                                                ? '🎨 design'
                                                                : f.phaseState?.requirements === 'approved'
                                                                ? '📋 PRD'
                                                                : '○ empty'}
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    <span className="nexus-spec-existing-or">or describe a new one below</span>
                                </div>
                            );
                        })()}

                        {/* V2.1.2 spec-fix-4: spec name field. Users name
                            their spec at the moment they describe it — the
                            name slugifies to a directory under .nexus/specs/
                            so multiple specs can coexist in one workspace.
                            Empty input falls back to the current feature
                            (default 'main' for new users). The slug preview
                            below the input shows what will land on disk. */}
                        <div className="nexus-spec-name-field">
                            <label className="nexus-spec-name-label" htmlFor="nexus-spec-name-input">
                                Spec name <span style={{ color: 'var(--vscode-descriptionForeground)', fontWeight: 'normal' }}>(optional — defaults to current)</span>
                            </label>
                            <input
                                id="nexus-spec-name-input"
                                type="text"
                                className="nexus-spec-name-input"
                                value={featureNameInput}
                                onChange={(e) => { setFeatureNameInput(e.target.value); setFeatureChangeError(''); }}
                                placeholder={`e.g. checkout-flow  (currently on: ${currentFeature})`}
                                autoComplete="off"
                            />
                            {featureNameInput.trim() !== '' && (
                                <div className="nexus-spec-name-preview">
                                    Will save to: <code>.nexus/specs/{slugifyForPreview(featureNameInput)}/</code>
                                    {slugifyForPreview(featureNameInput) === currentFeature && (
                                        <span style={{ marginLeft: '8px', color: 'var(--vscode-descriptionForeground)' }}>
                                            (same as current — will overwrite)
                                        </span>
                                    )}
                                </div>
                            )}
                            {featureChangeError && (
                                <div className="nexus-spec-name-error">⚠ {featureChangeError}</div>
                            )}
                        </div>

                        {builderContexts.length > 0 && (
                            <div className="context-chips" style={{ marginBottom: '5px' }}>
                                {builderContexts.map((ctx, idx) => (
                                    <FileChip
                                        key={idx}
                                        filepath={ctx.file}
                                        language={ctx.language}
                                        title={ctx.code}
                                        onRemove={() => setBuilderContexts(prev => prev.filter((_, i) => i !== idx))}
                                    />
                                ))}
                            </div>
                        )}

                        <div className="nexus-spec-attach-row">
                            <button
                                className="nexus-spec-attach-button"
                                onClick={() => { searchTargetRef.current = 'builder'; setIsSearching(true); }}
                            >
                                {Icons.Plus} Attach Specs / API Docs
                            </button>

                            {/* V2.1.2 spec-redesign: PDF + image upload from disk.
                                Distinct from the existing button (which searches
                                workspace files) because PDFs/images typically live
                                outside the repo (Confluence exports, screenshots,
                                etc.). */}
                            <button
                                className="nexus-spec-attach-button"
                                onClick={() => specFileInputRef.current?.click()}
                                title="Upload PDF or image from disk. Image content is preview-only — it is not sent to the model in the current configuration."
                            >
                                {Icons.Plus} Upload PDF / Image
                            </button>
                            <input
                                ref={specFileInputRef}
                                type="file"
                                accept="application/pdf,image/*,.txt,.md"
                                multiple
                                style={{ display: 'none' }}
                                onChange={(e) => { void handleSpecFiles(e.target.files); }}
                            />
                        </div>

                        {/* V2.1.2 spec-redesign: chip row showing each attachment
                            with type-specific preview + remove. Image chips include
                            an "image not analyzed" badge so users know that visual
                            content isn't ingested. */}
                        <AttachmentPreview
                            attachments={specAttachments}
                            onRemove={(idx) => setSpecAttachments(prev => prev.filter((_, i) => i !== idx))}
                        />

                        {isSearching && (
                            <div className="nexus-spec-search-panel">
                                <div className="nexus-spec-search-panel-header">
                                    <span className="nexus-spec-search-panel-title">{t("search.header")}</span>
                                    <button className="nexus-spec-search-close" onClick={() => setIsSearching(false)} title="Close">✖</button>
                                </div>
                                <input
                                    autoFocus
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) => {
                                        setSearchQuery(e.target.value);
                                        if (e.target.value.length > 2) { vscode.postMessage({ type: 'searchFiles', query: e.target.value }); }
                                        else setSearchResults([]);
                                    }}
                                    placeholder={t("search.placeholder_files")}
                                    className="nexus-spec-search-input"
                                />
                                <div className="nexus-spec-search-results">
                                    {searchResults.map(res => (
                                        <button key={res} className="nexus-spec-search-result"
                                            onClick={() => vscode.postMessage({ type: 'readFileContext', file: res })}>
                                            {Icons.File} {res}
                                        </button>
                                    ))}
                                    {searchQuery.length > 2 && searchResults.length === 0 && <div className="nexus-spec-search-empty">{t("search.no_files_found")}</div>}
                                </div>
                            </div>
                        )}

                        <textarea
                            className="nexus-spec-textarea"
                            value={rawIdea}
                            onChange={(e) => setRawIdea(e.target.value)}
                            placeholder="e.g. Build a checkout system. Use the attached Stripe API docs for the exact JSON payloads..."
                            rows={5}
                        />
                        <button
                            className="nexus-spec-cta"
                            onClick={() => {
                                if (!rawIdea.trim()) { return; }
                                setReqLogs([]);
                                setSpecError(null);

                                // V2.1.2 spec-fix-4: create-feature-first if the
                                // user typed a new name. The host queues messages
                                // serially, so by the time the planner LLM finishes
                                // and tries to writeRequirements, _currentFeature
                                // will already be the new slug. If they left the
                                // name empty or it matches the current slug, skip
                                // the create step (saving in place is OK).
                                const inputName = featureNameInput.trim();
                                if (inputName !== '') {
                                    const newSlug = slugifyForPreview(inputName);
                                    if (newSlug !== currentFeature) {
                                        vscode.postMessage({ type: 'createFeature', name: inputName });
                                    }
                                }

                                setIsGeneratingReqs(true);

                                // V2.1.2 spec-redesign: merge two context sources
                                //   1. builderContexts (workspace files attached
                                //      via the search panel — existing path)
                                //   2. specAttachments (uploaded PDFs/images/text
                                //      via the new upload button)
                                // The latter goes through buildAttachmentContext
                                // which knows to include "image not analyzed" notes
                                // so the model doesn't pretend it saw the diagram.
                                const builderCtx = builderContexts.length > 0
                                    ? builderContexts.map(c => `File: ${c.file}\n\`\`\`${c.language}\n${c.code}\n\`\`\``).join('\n\n')
                                    : '';
                                const attachCtx = buildAttachmentContext(specAttachments);
                                const contextStr = [builderCtx, attachCtx].filter(Boolean).join('\n\n');

                                // V2.1.2b — same scaffold pre-check as the
                                // chat submit path. Spec generation in an
                                // empty workspace is the canonical greenfield
                                // case, so this is where the dialog is most
                                // likely to fire.
                                const prdPayload: CapturedPayload = {
                                    type: 'generateRequirements',
                                    text: rawIdea,
                                    context: contextStr,
                                };
                                dispatchScaffoldAction({ type: 'userSubmitted', payload: prdPayload });
                            }}
                        >
                            {Icons.Wand} Auto-Generate RAG-Enhanced PRD
                        </button>
                    </div>
                )}

                {/* V2.1.2 spec-redesign: Stepper replaces the prior plan-card
                    progress UI. Visible whenever a phase is generating, OR
                    when there's a sticky error to display. */}
                {(isGeneratingReqs || isGeneratingDesign || isGeneratingTasks || specError) && (() => {
                    // Compute per-phase status. Order of precedence:
                    //   1. Active flag (this phase is currently generating)
                    //   2. Error flag (specError targets this phase)
                    //   3. Phase state from disk (approved/draft → completed)
                    //   4. Default idle
                    const phases: SpecStepperPhase[] = [
                        {
                            id: 'requirements',
                            label: 'Requirements',
                            status: isGeneratingReqs
                                ? 'active'
                                : specError?.phase === 'requirements'
                                    ? 'error'
                                    : (requirements && requirements.trim() !== '')
                                        ? 'completed'
                                        : 'idle',
                            ...(isGeneratingReqs ? { activityHint: 'Drafting user stories & acceptance criteria...' } : {}),
                        },
                        {
                            id: 'design',
                            label: 'Design',
                            status: isGeneratingDesign
                                ? 'active'
                                : specError?.phase === 'design'
                                    ? 'error'
                                    : (design && design.trim() !== '')
                                        ? 'completed'
                                        : 'idle',
                            ...(isGeneratingDesign ? { activityHint: 'Drafting system architecture...' } : {}),
                        },
                        {
                            id: 'tasks',
                            label: 'Tasks',
                            status: isGeneratingTasks
                                ? 'active'
                                : specError?.phase === 'tasks'
                                    ? 'error'
                                    : (activePlan && activePlan.implementationTasks && activePlan.implementationTasks.length > 0)
                                        ? 'completed'
                                        : 'idle',
                            ...(isGeneratingTasks ? { activityHint: 'Generating implementation tasks...' } : {}),
                        },
                    ];

                    return (
                        <div className="nexus-spec-stepper-wrap" style={{ marginTop: '10px' }}>
                            <SpecStepper
                                phases={phases}
                                error={specError}
                                onDismissError={() => setSpecError(null)}
                                onRetry={() => {
                                    if (!specError) { return; }
                                    setSpecError(null);
                                    if (specError.phase === 'requirements') {
                                        setIsGeneratingReqs(true);
                                        const builderCtx = builderContexts.length > 0
                                            ? builderContexts.map(c => `File: ${c.file}\n\`\`\`${c.language}\n${c.code}\n\`\`\``).join('\n\n')
                                            : '';
                                        const attachCtx = buildAttachmentContext(specAttachments);
                                        const contextStr = [builderCtx, attachCtx].filter(Boolean).join('\n\n');
                                        vscode.postMessage({ type: 'generateRequirements', text: rawIdea, context: contextStr });
                                    }
                                    // Design + tasks retry require their own
                                    // approval-state plumbing; users hit the
                                    // existing buttons in those panels for now.
                                }}
                            />

                            {(isGeneratingReqs || isGeneratingDesign || isGeneratingTasks) && (
                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
                                    <button
                                        className="nexus-spec-progress-stop"
                                        onClick={() => {
                                            vscode.postMessage({ type: 'cancelTask' });
                                            setIsGeneratingReqs(false);
                                            setIsGeneratingDesign(false);
                                            setIsGeneratingTasks(false);
                                        }}
                                    >
                                        {Icons.Stop} Stop
                                    </button>
                                </div>
                            )}

                            {/* V2.2 hotfix: Save & New Project button.
                                Visible on every spec page state (PRD,
                                design, tasks, post-tasks). Click to
                                save the current feature's state in
                                place and create a new feature for a
                                different project. The current feature
                                stays intact on disk and reappears in
                                the existing-spec picker so the user
                                can resume it later. */}
                            {!isGeneratingReqs && !isGeneratingDesign && !isGeneratingTasks && (
                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px', gap: '6px' }}>
                                    <button
                                        className="nexus-btn-ghost"
                                        style={{ fontSize: '11px', opacity: 0.85 }}
                                        onClick={() => {
                                            setSaveNewProjectName('');
                                            setShowSaveNewProjectDialog(true);
                                        }}
                                        title="Save current spec progress and start a new project. The current project stays intact and can be reopened from the spec picker.">
                                        💾 Save & New Project
                                    </button>
                                </div>
                            )}

                            {showSaveNewProjectDialog && (
                                <div style={{
                                    marginTop: '10px',
                                    padding: '12px',
                                    border: '1px solid var(--vscode-widget-border)',
                                    borderRadius: '6px',
                                    background: 'var(--vscode-editor-background)'
                                }}>
                                    <div style={{ marginBottom: '8px', fontSize: '12px', opacity: 0.9 }}>
                                        Save current project ({currentFeature}) and start a new one. The current state stays on disk — you can reopen it later from the existing-spec picker.
                                    </div>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                        <input
                                            type="text"
                                            value={saveNewProjectName}
                                            onChange={(e) => setSaveNewProjectName(e.target.value)}
                                            placeholder="New project name (e.g. payment-flow)"
                                            autoFocus
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && saveNewProjectName.trim()) {
                                                    vscode.postMessage({ type: 'createFeature', name: saveNewProjectName.trim() });
                                                    setShowSaveNewProjectDialog(false);
                                                } else if (e.key === 'Escape') {
                                                    setShowSaveNewProjectDialog(false);
                                                }
                                            }}
                                            style={{
                                                flex: 1,
                                                padding: '6px 8px',
                                                fontSize: '12px',
                                                background: 'var(--vscode-input-background)',
                                                color: 'var(--vscode-input-foreground)',
                                                border: '1px solid var(--vscode-input-border, var(--vscode-widget-border))',
                                                borderRadius: '3px'
                                            }}
                                        />
                                        <button
                                            className="nexus-btn-secondary"
                                            style={{ fontSize: '11px', padding: '4px 10px' }}
                                            onClick={() => setShowSaveNewProjectDialog(false)}>
                                            Cancel
                                        </button>
                                        <button
                                            className="nexus-btn-primary"
                                            style={{ fontSize: '11px', padding: '4px 10px' }}
                                            disabled={!saveNewProjectName.trim()}
                                            onClick={() => {
                                                vscode.postMessage({ type: 'createFeature', name: saveNewProjectName.trim() });
                                                setShowSaveNewProjectDialog(false);
                                            }}>
                                            Save & Switch
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })()}

                {(requirements && requirements.trim() !== '') && !design && !isGeneratingReqs && !isGeneratingDesign && (
                    <div className="nexus-flex-col">
                        <div className="nexus-flex-between-shrink">
                            <span className="nexus-flex-row nexus-text-success-bold">
                                {phaseState?.requirements === 'approved'
                                    ? <>{Icons.CheckCircle} PRD approved · .nexus/specs/{currentFeature}/requirements.md</>
                                    : <>{Icons.FilePen} PRD draft · .nexus/specs/{currentFeature}/requirements.md</>}
                            </span>
                            <div className="nexus-flex-block-gap-3">
                                {/* V2.1.2 spec-fix-4: feature switcher. Clickable
                                    pill opens a menu listing all features in the
                                    workspace + a "+ New Spec" entry. */}
                                <div className="nexus-feature-switcher">
                                    <button
                                        className="nexus-feature-switcher-pill"
                                        onClick={() => setShowFeatureSwitcher(v => !v)}
                                        title="Switch spec or create new"
                                    >
                                        🗂️ {currentFeature} ▾
                                    </button>
                                    {showFeatureSwitcher && (
                                        <div className="nexus-feature-switcher-menu" onMouseLeave={() => setShowFeatureSwitcher(false)}>
                                            {featureList.map(f => (
                                                <button
                                                    key={f.slug}
                                                    className={`nexus-feature-switcher-item${f.slug === currentFeature ? ' active' : ''}`}
                                                    onClick={() => {
                                                        if (f.slug !== currentFeature) {
                                                            vscode.postMessage({ type: 'setCurrentFeature', slug: f.slug });
                                                        }
                                                        setShowFeatureSwitcher(false);
                                                    }}
                                                >
                                                    <span>{f.slug === currentFeature ? '● ' : '  '}{f.slug}</span>
                                                    <span className="nexus-feature-switcher-status">
                                                        {f.phaseState?.tasks === 'approved'
                                                            ? '✅ ready'
                                                            : f.phaseState?.tasks === 'draft'
                                                            ? '📝 tasks'
                                                            : f.phaseState?.design === 'approved'
                                                            ? '🎨 design'
                                                            : f.phaseState?.requirements === 'approved'
                                                            ? '📋 PRD'
                                                            : '○ empty'}
                                                    </span>
                                                </button>
                                            ))}
                                            <div className="nexus-feature-switcher-divider" />
                                            <button
                                                className="nexus-feature-switcher-item nexus-feature-switcher-new"
                                                onClick={() => {
                                                    const name = window.prompt('Name your new spec (e.g. checkout-flow):');
                                                    if (name && name.trim()) {
                                                        vscode.postMessage({ type: 'createFeature', name: name.trim() });
                                                    }
                                                    setShowFeatureSwitcher(false);
                                                }}
                                            >
                                                + New Spec
                                            </button>
                                        </div>
                                    )}
                                </div>
                                <button className="nexus-btn-ghost" onClick={() => setIsEditingReqs(!isEditingReqs)}>
                                    {isEditingReqs ? <>{Icons.Eye} Preview</> : <>{Icons.Edit} Edit</>}
                                </button>
                                {/* V2.2 hotfix #3: non-destructive navigation
                                    back to PRD. Only renders when PRD is
                                    already approved (otherwise we're already
                                    on/before the PRD phase, no point in
                                    reopening). Distinct from Start Over —
                                    keeps all files on disk, only flips
                                    phaseState.requirements to 'draft' so the
                                    user can edit + re-approve without losing
                                    design and tasks. */}
                                {phaseState?.requirements === 'approved' && (
                                    <button className="nexus-btn-ghost"
                                        onClick={() => {
                                            vscode.postMessage({ type: 'reopenPRD' });
                                        }}
                                        title="Reopen the PRD for edits without deleting design or tasks">
                                        {Icons.Edit} Reopen PRD
                                    </button>
                                )}
                                <button className="nexus-btn-ghost"
                                    onClick={() => {
                                        // V2.1.2 spec-fix-3: full reset via host. Local
                                        // state clear alone left phaseState.json on disk
                                        // with stale approved flags, breaking re-generation.
                                        setRequirements(''); setRawIdea(''); setReqLogs([]); setIsEditingReqs(false);
                                        setSpecError(null);
                                        setSpecAttachments([]);
                                        setActivePlan(null);
                                        setDesign('');
                                        setIsEditingDesign(false);
                                        vscode.postMessage({ type: 'startOver' });
                                    }}>
                                    {Icons.Restart} Start Over
                                </button>
                            </div>
                        </div>

                        {!isEditingReqs ? (
                            <div className="markdown-body nexus-scroll-preview">
                                <ReactMarkdown>{cleanTraceabilityTags(requirements)}</ReactMarkdown>
                            </div>
                        ) : (
                            <>
                                {/* PR 3.1: EARS helper bar. Lets the user
                                    drop in WHEN / IF / WHILE / WHERE /
                                    THE SYSTEM SHALL at the cursor with
                                    a single click. Compliance convention:
                                    keywords stay UPPERCASE ENGLISH in
                                    every locale. */}
                                <EarsHelper
                                    onInsert={(snippet) => {
                                        const ta = requirementsTextareaRef.current;
                                        if (!ta) { return; }
                                        const { value, cursorPos } = insertAtCursor(ta, snippet);
                                        setRequirements(value);
                                        vscode.postMessage({ type: 'updateRequirements', text: value });
                                        // Restore cursor position after React re-render. We schedule
                                        // through requestAnimationFrame so the DOM has the new value
                                        // before we reposition the caret.
                                        requestAnimationFrame(() => {
                                            ta.focus();
                                            ta.setSelectionRange(cursorPos, cursorPos);
                                        });
                                    }}
                                />
                                <textarea
                                    ref={requirementsTextareaRef}
                                    className="nexus-textarea-mono"
                                    value={requirements}
                                    onChange={(e) => { setRequirements(e.target.value); vscode.postMessage({ type: 'updateRequirements', text: e.target.value }); }}
                                />
                            </>
                        )}

                        {/* Phase-gate UX: explicit Approve / Reject before unlocking the next phase. See audit §11. */}
                        {phaseState?.requirements !== 'approved' ? (
                            <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
                                <button
                                    className="nexus-btn-secondary"
                                    onClick={() => vscode.postMessage({ type: 'rejectPhase', phase: 'requirements' })}
                                >
                                    <span className="nexus-flex-row">{Icons.Restart} Reject &amp; Regenerate</span>
                                </button>
                                <button
                                    className="nexus-btn-primary"
                                    onClick={() => vscode.postMessage({ type: 'approvePhase', phase: 'requirements' })}
                                >
                                    <span className="nexus-flex-row">{Icons.Check} Approve PRD</span>
                                </button>
                            </div>
                        ) : (
                            <button
                                className="nexus-spec-cta"
                                style={{ flexShrink: 0 }}
                                onClick={() => {
                                    setIsGeneratingDesign(true);
                                    setReqLogs([]);
                                    vscode.postMessage({ type: 'generateDesign', requirements });
                                }}
                            >
                                {Icons.Sparkles} Generate Architecture Design
                            </button>
                        )}
                    </div>
                )}

                {(requirements && design) && !isGeneratingDesign && (
                    <div className="nexus-flex-col">
                        <div className="nexus-flex-between-shrink">
                            <span className="nexus-flex-row nexus-text-success-bold">
                                {phaseState?.design === 'approved'
                                    ? <>{Icons.CheckCircle} Design approved · .nexus/specs/{currentFeature}/</>
                                    : <>{Icons.FilePen} Design draft · .nexus/specs/{currentFeature}/</>}
                            </span>
                            <div className="nexus-flex-block-gap-3">
                                <div className="nexus-feature-switcher">
                                    <button
                                        className="nexus-feature-switcher-pill"
                                        onClick={() => setShowFeatureSwitcher(v => !v)}
                                        title="Switch spec or create new"
                                    >
                                        🗂️ {currentFeature} ▾
                                    </button>
                                    {showFeatureSwitcher && (
                                        <div className="nexus-feature-switcher-menu" onMouseLeave={() => setShowFeatureSwitcher(false)}>
                                            {featureList.map(f => (
                                                <button
                                                    key={f.slug}
                                                    className={`nexus-feature-switcher-item${f.slug === currentFeature ? ' active' : ''}`}
                                                    onClick={() => {
                                                        if (f.slug !== currentFeature) {
                                                            vscode.postMessage({ type: 'setCurrentFeature', slug: f.slug });
                                                        }
                                                        setShowFeatureSwitcher(false);
                                                    }}
                                                >
                                                    <span>{f.slug === currentFeature ? '● ' : '  '}{f.slug}</span>
                                                    <span className="nexus-feature-switcher-status">
                                                        {f.phaseState?.tasks === 'approved'
                                                            ? '✅ ready'
                                                            : f.phaseState?.tasks === 'draft'
                                                            ? '📝 tasks'
                                                            : f.phaseState?.design === 'approved'
                                                            ? '🎨 design'
                                                            : f.phaseState?.requirements === 'approved'
                                                            ? '📋 PRD'
                                                            : '○ empty'}
                                                    </span>
                                                </button>
                                            ))}
                                            <div className="nexus-feature-switcher-divider" />
                                            <button
                                                className="nexus-feature-switcher-item nexus-feature-switcher-new"
                                                onClick={() => {
                                                    const name = window.prompt('Name your new spec (e.g. checkout-flow):');
                                                    if (name && name.trim()) {
                                                        vscode.postMessage({ type: 'createFeature', name: name.trim() });
                                                    }
                                                    setShowFeatureSwitcher(false);
                                                }}
                                            >
                                                + New Spec
                                            </button>
                                        </div>
                                    )}
                                </div>
                                <button className="nexus-btn-ghost" onClick={() => setIsEditingDesign(!isEditingDesign)}>
                                    {isEditingDesign ? <>{Icons.Eye} Preview</> : <>{Icons.Edit} Edit Design</>}
                                </button>
                                {/* V2.2 hotfix #3: non-destructive reopen
                                    PRD button on the design+ view too. */}
                                {phaseState?.requirements === 'approved' && (
                                    <button className="nexus-btn-ghost"
                                        onClick={() => {
                                            vscode.postMessage({ type: 'reopenPRD' });
                                        }}
                                        title="Reopen the PRD for edits without deleting design or tasks">
                                        {Icons.Edit} Reopen PRD
                                    </button>
                                )}
                                <button className="nexus-btn-ghost"
                                    onClick={() => {
                                        // V2.1.2 spec-fix-3: full reset via host.
                                        setRequirements(''); setDesign(''); setRawIdea(''); setReqLogs([]); setIsEditingReqs(false); setIsEditingDesign(false);
                                        setSpecError(null);
                                        setSpecAttachments([]);
                                        setActivePlan(null);
                                        vscode.postMessage({ type: 'startOver' });
                                    }}>
                                    {Icons.Restart} Start Over
                                </button>
                            </div>
                        </div>

                        {!isEditingDesign ? (
                            <div className="markdown-body nexus-scroll-preview">
                                <h2>1. Product Requirements</h2>
                                <ReactMarkdown>{cleanTraceabilityTags(requirements)}</ReactMarkdown>
                                <hr />
                                <h2>2. System Design</h2>
                                <ReactMarkdown>{cleanTraceabilityTags(design)}</ReactMarkdown>
                                {/* V2.2 hotfix #5: render the implementation
                                    tasks inline on the spec page so the user
                                    can review them before clicking Approve.
                                    Previously the tasks only appeared on the
                                    workspace (chat) page, leaving the spec
                                    page with just a count in the button label
                                    — confusing UX (user expected to read the
                                    plan in context with the PRD/design).

                                    Renders gated on activePlan having content;
                                    we don't gate on phaseState.tasks because
                                    we want the user to see the tasks the
                                    moment they're generated, even before
                                    approval. Once approved, the section
                                    keeps rendering — same content, just no
                                    longer awaiting action. */}
                                {activePlan && activePlan.implementationTasks && activePlan.implementationTasks.length > 0 && (
                                    <>
                                        <hr />
                                        <h2>3. Implementation Tasks ({activePlan.implementationTasks.length})</h2>
                                        <ol style={{ paddingLeft: '20px', marginTop: '8px' }}>
                                            {activePlan.implementationTasks.map((rawTask, idx) => {
                                                if (typeof rawTask === 'string') {
                                                    return (
                                                        <li key={idx} style={{ marginBottom: '8px' }}>
                                                            {rawTask}
                                                        </li>
                                                    );
                                                }
                                                const task = rawTask as ProjectTask;
                                                return (
                                                    <li key={idx} style={{ marginBottom: '14px' }}>
                                                        <div style={{ fontWeight: 600 }}>
                                                            {task.step}
                                                        </div>
                                                        <div style={{ marginTop: '3px', fontSize: '12px', opacity: 0.85 }}>
                                                            <code style={{
                                                                padding: '1px 5px',
                                                                borderRadius: '3px',
                                                                background: 'var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1))',
                                                                fontSize: '11px'
                                                            }}>
                                                                {task.file}
                                                            </code>
                                                            {task.relatedRequirement && (
                                                                <span style={{ marginLeft: '8px', opacity: 0.7 }}>
                                                                    · {task.relatedRequirement}
                                                                </span>
                                                            )}
                                                        </div>
                                                        {task.detailedInstructions && (
                                                            <div style={{ marginTop: '4px', fontSize: '12px', opacity: 0.75, lineHeight: 1.4 }}>
                                                                {task.detailedInstructions}
                                                            </div>
                                                        )}
                                                    </li>
                                                );
                                            })}
                                        </ol>
                                    </>
                                )}
                            </div>
                        ) : (
                            <textarea
                                className="nexus-textarea-mono"
                                value={design}
                                onChange={(e) => { setDesign(e.target.value); vscode.postMessage({ type: 'updateDesign', text: e.target.value }); }}
                            />
                        )}

                        {isGeneratingTasks ? (
                            // V2.1.2 spec-redesign-fix: the inline tasks loader was
                            // a duplicate of the SpecStepper at the top of the page.
                            // Hide action buttons during generation; the stepper
                            // shows progress + the stop button. We render an empty
                            // fragment here rather than removing the conditional
                            // entirely so the structure mirrors design + requirements
                            // phases (which also blank out their action rows during
                            // generation).
                            <></>
                        ) : (
                            // V2.2 hotfix-2: when PRD has been reopened (e.g. via
                            // the Reopen PRD button), phaseState.requirements is
                            // 'draft' but design content is still on disk. The
                            // page renders this design+ branch — but the design
                            // approve button doesn't help advance the user. They
                            // need to re-approve PRD first. Without this branch
                            // the user is stuck with no actionable button.
                            phaseState?.requirements === 'draft' ? (
                                <div className="nexus-action-row">
                                    <button
                                        className="nexus-btn-secondary"
                                        onClick={() => vscode.postMessage({ type: 'rejectPhase', phase: 'requirements' })}
                                    >
                                        <span className="nexus-flex-row">{Icons.Restart} Reject &amp; Regenerate PRD</span>
                                    </button>
                                    <button
                                        className="nexus-btn-primary"
                                        onClick={() => vscode.postMessage({ type: 'approvePhase', phase: 'requirements' })}
                                    >
                                        <span className="nexus-flex-row">{Icons.Check} Approve PRD</span>
                                    </button>
                                </div>
                            ) :
                            // Phase-gate UX for the design → tasks transition. See audit §11.
                            phaseState?.design !== 'approved' ? (
                                <div className="nexus-action-row">
                                    <button
                                        className="nexus-btn-secondary"
                                        onClick={() => vscode.postMessage({ type: 'rejectPhase', phase: 'design' })}
                                    >
                                        <span className="nexus-flex-row">{Icons.Restart} Reject &amp; Regenerate</span>
                                    </button>
                                    <button
                                        className="nexus-btn-primary"
                                        onClick={() => vscode.postMessage({ type: 'approvePhase', phase: 'design' })}
                                    >
                                        <span className="nexus-flex-row">{Icons.Check} Approve Design</span>
                                    </button>
                                </div>
                            ) : (
                                /* Design approved — three sub-states for tasks phase:
                                 *   1. Tasks not yet generated → Generate / Just Save
                                 *   2. Tasks drafted (phaseState.tasks === 'draft')   → Reject / Approve Tasks
                                 *   3. Tasks approved → Go to Coder
                                 *
                                 * V2.1.2 spec-redesign-fix: state 2 was previously
                                 * missing entirely. Users who clicked "Generate
                                 * Implementation Plan" got bounced to Coder with
                                 * no chance to approve, AND the spec page kept
                                 * showing the "Generate Implementation Plan" button
                                 * (because nothing checked phaseState.tasks). Both
                                 * are fixed by this state-machine. */
                                phaseState?.tasks === 'approved' ? (
                                    <div className="nexus-action-row">
                                        <span className="nexus-flex-row nexus-text-success-bold" style={{ marginRight: 'auto' }}>
                                            {Icons.CheckCircle} All phases approved
                                        </span>
                                        <button
                                            className="nexus-btn-primary"
                                            onClick={() => setActiveTab('coder')}
                                        >
                                            <span className="nexus-flex-row">{Icons.Zap} Go to Coder &amp; Execute</span>
                                        </button>
                                    </div>
                                ) : phaseState?.tasks === 'draft' && activePlan ? (
                                    <div className="nexus-action-row">
                                        <button
                                            className="nexus-btn-secondary"
                                            onClick={() => vscode.postMessage({ type: 'rejectPhase', phase: 'tasks' })}
                                        >
                                            <span className="nexus-flex-row">{Icons.Restart} Reject &amp; Regenerate</span>
                                        </button>
                                        <button
                                            className="nexus-btn-primary"
                                            onClick={() => vscode.postMessage({ type: 'approvePhase', phase: 'tasks' })}
                                        >
                                            <span className="nexus-flex-row">{Icons.Check} Approve Tasks ({activePlan.implementationTasks.length})</span>
                                        </button>
                                    </div>
                                ) : (
                                    <div className="nexus-action-row">
                                        <button
                                            className="nexus-btn-secondary"
                                            onClick={() => {
                                                vscode.postMessage({ type: 'updateRequirements', text: requirements });
                                                vscode.postMessage({ type: 'updateDesign', text: design });
                                                setActiveTab('coder');
                                            }}
                                        >
                                            <span className="nexus-flex-row">{Icons.Save} Just Save</span>
                                        </button>
                                        <button
                                            className="nexus-btn-primary"
                                            onClick={() => {
                                                setIsGeneratingTasks(true);
                                                vscode.postMessage({ type: 'generateProjectTasks' });
                                            }}
                                        >
                                            <span className="nexus-flex-row">{Icons.Zap} Generate Implementation Plan</span>
                                        </button>
                                    </div>
                                )
                            )
                        )}
                    </div>
                )}
            </div>

            {/* ========================================================= */}
            {/* ✨ TAB 3: AGENT SKILLS & RULES (.nexusrules)              */}
            {/* ========================================================= */}
            <div className="nexus-skill-view" style={{ display: activeTab === 'rules' ? 'flex' : 'none' }}>
                <div className="nexus-skill-view-inner">
                    <h3 className="nexus-skill-view-header">{t("skills.header")}</h3>
                    <p className="nexus-skill-view-description">
                        Define custom behaviors, preferred libraries, and architectural rules. The AI will strictly follow these instructions when writing code. Saves to <code>.nexusrules</code>.
                    </p>

                    <textarea
                        className="nexus-skill-view-textarea"
                        value={nexusRules}
                        onChange={(e) => setNexusRules(e.target.value)}
                        placeholder="e.g., Always use Tailwind CSS. Never use class components. Prefer Axios over fetch. All functions must include JSDoc comments."
                    />

                    <div className="nexus-skill-view-actions">
                        <button
                            className="nexus-btn-primary"
                            onClick={() => vscode.postMessage({ type: 'saveNexusRules', text: nexusRules })}
                        >
                            Save Agent Skills
                        </button>
                    </div>
                </div>
            </div>

            {/* ========================================================= */}
            {/* 🌌 TAB 4: THE SPLIT-VIEW MATRIX (Traceability Map)        */}
            {/* ========================================================= */}
            <div className="nexus-map-tab" style={{ display: activeTab === 'Map' ? 'flex' : 'none' }}>

                {/* V2.1.2 spec-fix-6 (Option A): compact toolbar. Single row,
                    36px tall, using pill styling matching the rest of V2.1.2.
                    The granularity toggle stays mounted (not conditionally
                    rendered) so the layout doesn't shift when the user
                    switches between codeMap/reqMap/combinedMap; we just
                    disable it when irrelevant. */}
                <div className="nexus-map-toolbar">
                    {/* Map type pills — left cluster */}
                    <div className="nexus-map-toolbar-cluster">
                        <button
                            className={`nexus-map-pill${activeMapType === 'codeMap' ? ' active' : ''}`}
                            onClick={() => setActiveMapType('codeMap')}
                        >
                            📊 Code
                        </button>
                        <button
                            className={`nexus-map-pill${activeMapType === 'reqMap' ? ' active' : ''}`}
                            onClick={() => setActiveMapType('reqMap')}
                        >
                            📋 Reqs
                            {(isGraphLoading && activeMapType === 'reqMap') && <span className="spin" style={{ marginLeft: '6px' }}>{Icons.Loader}</span>}
                        </button>
                        <button
                            className={`nexus-map-pill${activeMapType === 'combinedMap' ? ' active' : ''}`}
                            onClick={() => setActiveMapType('combinedMap')}
                        >
                            🔗 Combined
                            {(isGraphLoading && activeMapType === 'combinedMap') && <span className="spin" style={{ marginLeft: '6px' }}>{Icons.Loader}</span>}
                        </button>
                    </div>

                    <div className="nexus-map-toolbar-divider" />

                    {/* Granularity pills — middle cluster. Disabled when not
                        in codeMap mode, but stays visible to prevent layout
                        shift. v2.8 will extend symbol-level to non-TS/JS
                        languages (see roadmap B2). */}
                    <div className="nexus-map-toolbar-cluster">
                        <button
                            className={`nexus-map-pill${graphGranularity === 'file' ? ' active' : ''}${activeMapType !== 'codeMap' ? ' disabled' : ''}`}
                            onClick={() => activeMapType === 'codeMap' && setGraphGranularity('file')}
                            disabled={activeMapType !== 'codeMap'}
                            title="Show one node per file. Edges represent imports between files."
                        >
                            📄 Files
                        </button>
                        <button
                            className={`nexus-map-pill${graphGranularity === 'symbol' ? ' active' : ''}${activeMapType !== 'codeMap' ? ' disabled' : ''}`}
                            onClick={() => activeMapType === 'codeMap' && setGraphGranularity('symbol')}
                            disabled={activeMapType !== 'codeMap'}
                            title="Show function and class nodes within each file. TypeScript/JavaScript only for now; multi-language support ships with backlog item B2."
                        >
                            ƒ Symbols
                        </button>
                    </div>

                    {/* V2.1.2 spec-fix-6: spec filter. Only shown for reqMap
                        and combinedMap (codeMap doesn't have a per-spec
                        dimension), and only when there's more than one spec
                        to filter between. */}
                    {(activeMapType === 'reqMap' || activeMapType === 'combinedMap') && featureList.length > 1 && (
                        <>
                            <div className="nexus-map-toolbar-divider" />
                            <div className="nexus-map-spec-filter">
                                <button
                                    className="nexus-map-pill"
                                    onClick={() => setShowSpecFilterMenu(v => !v)}
                                >
                                    🗂️ {(() => {
                                        if (selectedSpecSlugs === null) {
                                            return `All specs (${featureList.length})`;
                                        }
                                        if (selectedSpecSlugs.size === 1) {
                                            const only = Array.from(selectedSpecSlugs)[0];
                                            return `${only} only`;
                                        }
                                        return `${selectedSpecSlugs.size} of ${featureList.length} specs`;
                                    })()} ▾
                                </button>
                                {showSpecFilterMenu && (
                                    <div className="nexus-map-spec-filter-menu" onMouseLeave={() => setShowSpecFilterMenu(false)}>
                                        <div className="nexus-map-spec-filter-actions">
                                            <button
                                                className="nexus-map-spec-filter-action"
                                                onClick={() => setSelectedSpecSlugs(null)}
                                            >
                                                Show all
                                            </button>
                                            <button
                                                className="nexus-map-spec-filter-action"
                                                onClick={() => setSelectedSpecSlugs(new Set())}
                                            >
                                                Hide all
                                            </button>
                                        </div>
                                        <div className="nexus-map-spec-filter-divider" />
                                        {featureList.map(f => {
                                            const isShown = selectedSpecSlugs === null || selectedSpecSlugs.has(f.slug);
                                            return (
                                                <label key={f.slug} className="nexus-map-spec-filter-item">
                                                    <input
                                                        type="checkbox"
                                                        checked={isShown}
                                                        onChange={(e) => {
                                                            // Materialize null → full set on first toggle so
                                                            // we can mutate it. After that, normal Set ops.
                                                            const next = selectedSpecSlugs === null
                                                                ? new Set(featureList.map(x => x.slug))
                                                                : new Set(selectedSpecSlugs);
                                                            if (e.target.checked) { next.add(f.slug); }
                                                            else { next.delete(f.slug); }
                                                            // Convenience: if user re-selected everything, fold
                                                            // back to null so the label shows "All specs" again.
                                                            if (next.size === featureList.length) {
                                                                setSelectedSpecSlugs(null);
                                                            } else {
                                                                setSelectedSpecSlugs(next);
                                                            }
                                                        }}
                                                    />
                                                    <span className="nexus-map-spec-filter-slug">{f.slug}</span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    {/* Right cluster: refresh button. Pushed to far right via
                        auto margin. V2.1.2 spec-fix-8: always force-rebuild,
                        bypassing the disk cache. The cache itself is kept up
                        to date by passive opens; this button is the manual
                        escape hatch when the user suspects staleness. */}
                    <button
                        className="nexus-map-pill nexus-map-pill-action"
                        onClick={() => vscode.postMessage({ type: 'requestWorkspaceGraph', force: true })}
                        title="Re-index workspace and re-parse all specs from scratch (bypasses cache, slower)"
                        style={{ marginLeft: 'auto' }}
                    >
                        ↻ Refresh
                    </button>
                </div>

                {/* V2.1.2 spec-fix-5: per-feature aggregation status. Shows
                    the user how many specs made it into the matrix and which
                    ones failed. Without this, partial failures look like
                    "matrix is broken" with no diagnostic. Only relevant to
                    reqMap and combinedMap views — codeMap is per-workspace,
                    not per-spec. */}
                {(activeMapType === 'reqMap' || activeMapType === 'combinedMap') && graphPayload && typeof graphPayload.featureCount === 'number' && graphPayload.featureCount > 0 && (
                    <div className="nexus-traceability-aggregate-banner">
                        {(() => {
                            const total = graphPayload.featureCount as number;
                            const ok = graphPayload.featuresWithReqs as number || 0;
                            const warnings: { slug: string; phase: string; reason: string }[] = graphPayload.featureWarnings || [];
                            // V2.1.2 spec-fix-8: cache stats. Counts are per-graph
                            // (req + design) not per-feature, so a fully-cached
                            // 5-spec workspace shows up to 10 hits.
                            const cacheHits = graphPayload.cacheHits as number || 0;
                            const cacheMisses = graphPayload.cacheMisses as number || 0;
                            const totalParses = cacheHits + cacheMisses;
                            const cacheBadge = totalParses > 0 ? (
                                cacheMisses === 0
                                    ? <span className="nexus-traceability-aggregate-cache"> · all from cache</span>
                                    : cacheHits === 0
                                        ? <span className="nexus-traceability-aggregate-cache"> · all freshly parsed</span>
                                        : <span className="nexus-traceability-aggregate-cache"> · {cacheHits} from cache, {cacheMisses} fresh</span>
                            ) : null;

                            if (ok === total && warnings.length === 0) {
                                return (
                                    <span className="nexus-traceability-aggregate-ok">
                                        ✓ Aggregating {total} spec{total === 1 ? '' : 's'} into the matrix
                                        {cacheBadge}
                                    </span>
                                );
                            }
                            if (ok > 0) {
                                return (
                                    <details className="nexus-traceability-aggregate-partial">
                                        <summary>
                                            ⚠ Got {ok} of {total} specs into the matrix. {warnings.length} issue{warnings.length === 1 ? '' : 's'}.
                                            {cacheBadge}
                                        </summary>
                                        <ul className="nexus-traceability-aggregate-issues">
                                            {warnings.map((w, idx) => (
                                                <li key={idx}>
                                                    <code>{w.slug}</code> ({w.phase}): {w.reason}
                                                </li>
                                            ))}
                                        </ul>
                                    </details>
                                );
                            }
                            return (
                                <details className="nexus-traceability-aggregate-failed">
                                    <summary>✕ Could not aggregate any specs into the matrix.{cacheBadge}</summary>
                                    <ul className="nexus-traceability-aggregate-issues">
                                        {warnings.map((w, idx) => (
                                            <li key={idx}>
                                                <code>{w.slug}</code> ({w.phase}): {w.reason}
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            );
                        })()}
                    </div>
                )}

                {/* Split View Body */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>

                    {/* LEFT SIDE: WebGL 3D Canvas (60% Width) */}
                    <div ref={graphContainerRef} className="nexus-map-canvas-container" style={{ flex: 3, position: 'relative', overflow: 'hidden' }}>

                        {/* 🚀 THE NEW HUD OVERLAY: Shows exactly what the LLM is doing in the background! */}
                        {isGraphLoading && (
                            <div style={{
                                position: 'absolute',
                                bottom: '30px',
                                left: '50%',
                                transform: 'translateX(-50%)',
                                background: 'rgba(13, 17, 23, 0.95)',
                                border: '1px solid #58a6ff',
                                borderRadius: '8px',
                                padding: '16px 24px',
                                zIndex: 1000,
                                boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 15px rgba(88, 166, 255, 0.15)',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                gap: '8px',
                                minWidth: '320px'
                            }}>
                                <div className="nexus-flex-block-row-gap-3">
                                    <div style={{ color: '#58a6ff' }} className="spin">{Icons.Loader}</div>
                                    <span style={{ color: 'white', fontWeight: 'bold', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '1px' }}>AI Matrix Synthesis</span>
                                </div>
                                <div style={{ color: '#58a6ff', fontSize: '11px', fontFamily: 'monospace', opacity: 0.9, textAlign: 'center', padding: '4px 0' }}>
                                    {agentStatus || 'Vectorizing abstract requirements...'}
                                </div>
                            </div>
                        )}

                        {!graphData ? (
                            <div style={{ color: '#8b949e', position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>{t("search.scanning_workspace")}</div>
                        ) : (visualGraphData.nodes.length === 0) ? (
                            // V2.1.2 spec-fix-4: empty-state diagnostic. Without
                            // this overlay the user just sees a blank canvas
                            // when the graph is empty — they can't tell whether
                            // the index is broken, the workspace has no code,
                            // or they haven't generated requirements yet.
                            <div className="nexus-codemap-empty-overlay">
                                {activeMapType === 'codeMap' ? (
                                    <>
                                        <div className="nexus-codemap-empty-overlay-title">No source files indexed</div>
                                        <div>The code map scans <code>.ts .tsx .js .jsx .py .go .java .rs .vue .svelte .html .css</code> files in your workspace.</div>
                                        <div className="nexus-codemap-empty-overlay-hint">If your project uses other languages, file existence is not currently tracked. Try ↻ Refresh after adding code.</div>
                                    </>
                                ) : activeMapType === 'reqMap' ? (
                                    <>
                                        <div className="nexus-codemap-empty-overlay-title">No requirements found</div>
                                        <div>No <code>requirements.md</code> exists in any spec under <code>.nexus/specs/</code>.</div>
                                        <div className="nexus-codemap-empty-overlay-hint">Generate a PRD in the Spec tab, then ↻ Refresh here.</div>
                                    </>
                                ) : (
                                    <>
                                        <div className="nexus-codemap-empty-overlay-title">Combined map is empty</div>
                                        <div>The combined view requires both source files AND a generated PRD.</div>
                                        <div className="nexus-codemap-empty-overlay-hint">Check Code Map and Requirements Map tabs above to see which side is empty.</div>
                                    </>
                                )}
                            </div>
                        ) : (
                            <Suspense fallback={
                                <div style={{ color: '#8b949e', position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
                                    {t("traceability.loading_3d") || 'Loading 3D engine...'}
                                </div>
                            }>
                                <MapGraph
                                    mapKey={`${activeMapType}::${graphGranularity}`}
                                    width={graphDims.width}
                                    height={graphDims.height}
                                    graphData={visualGraphData}
                                    onNodeClick={(node) => {
                                        // Single click → populate side panel.
                                        // Symbol nodes encode their parent file as
                                        // "filepath::symbolName" — split here to
                                        // surface both pieces in the panel.
                                        if (node.group === 'external_lib') { return; }
                                        const [maybeFilepath, maybeSymbol] = node.id.split('::');
                                        const filepath = maybeSymbol !== undefined ? maybeFilepath : node.id;
                                        const symbol = maybeSymbol !== undefined ? maybeSymbol : undefined;
                                        const sel: { id: string; name: string; group: string | undefined; filepath?: string; symbol?: string } = {
                                            id: node.id,
                                            name: node.id.split('/').pop() || node.id,
                                            group: node.group,
                                        };
                                        if (filepath !== undefined) { sel.filepath = filepath; }
                                        if (symbol !== undefined) { sel.symbol = symbol; }
                                        setSelectedGraphNode(sel);

                                        // Also keep the existing scroll-to-card
                                        // behavior so users who relied on the old
                                        // jump-to-detail UX don't lose it.
                                        const safeId = `node-card-${node.id.replace(/[^a-zA-Z0-9-]/g, '-')}`;
                                        const el = document.getElementById(safeId);
                                        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
                                        if (el) {
                                            el.style.borderColor = '#58a6ff';
                                            setTimeout(() => { el.style.borderColor = 'var(--vscode-input-border)'; }, 1500);
                                        }
                                    }}
                                    onNodeDoubleClick={(node) => {
                                        // Double-click → open the file (and jump
                                        // to the symbol if this was a symbol-
                                        // level node). External libs aren't on
                                        // disk, so we skip those.
                                        if (node.group === 'external_lib') { return; }
                                        const [maybeFilepath, maybeSymbol] = node.id.split('::');
                                        const filepath = maybeSymbol !== undefined ? maybeFilepath : node.id;
                                        if (!filepath) { return; }
                                        const payload: { type: string; filepath: string; symbol?: string } = {
                                            type: 'openFile',
                                            filepath,
                                        };
                                        if (maybeSymbol !== undefined) { payload.symbol = maybeSymbol; }
                                        vscode.postMessage(payload);
                                    }}
                                />
                            </Suspense>
                        )}
                    </div>

                    {/* RIGHT SIDE: Text Detail Sidebar (40% Width) */}
                    <div className="nexus-map-side-panel">
                        {/* Selected-node detail card. Single click on a graph
                            node populates this; double click opens the file
                            in the editor. The card stays visible until the
                            user picks another node or dismisses it. */}
                        {selectedGraphNode && (
                            <div className="nexus-graph-selected-card">
                                <div className="nexus-graph-selected-card__header">
                                    <span className="nexus-graph-selected-card__kind">
                                        {selectedGraphNode.symbol
                                            ? (selectedGraphNode.group === 'class' ? '© Class' : 'ƒ Function')
                                            : '📄 File'}
                                    </span>
                                    <button
                                        type="button"
                                        className="nexus-graph-selected-card__close"
                                        onClick={() => setSelectedGraphNode(null)}
                                        title="Clear selection"
                                    >×</button>
                                </div>
                                <div className="nexus-graph-selected-card__name">
                                    {selectedGraphNode.symbol ?? selectedGraphNode.name}
                                </div>
                                {selectedGraphNode.symbol && selectedGraphNode.filepath && (
                                    <div className="nexus-graph-selected-card__parent">
                                        in <code>{selectedGraphNode.filepath}</code>
                                    </div>
                                )}
                                <div className="nexus-graph-selected-card__actions">
                                    <button
                                        type="button"
                                        className="nexus-graph-selected-card__open-btn"
                                        onClick={() => {
                                            if (!selectedGraphNode.filepath) { return; }
                                            const payload: { type: string; filepath: string; symbol?: string } = {
                                                type: 'openFile',
                                                filepath: selectedGraphNode.filepath,
                                            };
                                            if (selectedGraphNode.symbol) { payload.symbol = selectedGraphNode.symbol; }
                                            vscode.postMessage(payload);
                                        }}
                                        disabled={!selectedGraphNode.filepath}
                                    >
                                        ↗ Open in Editor
                                    </button>
                                    <span className="nexus-graph-selected-card__hint">
                                        Tip: double-click any node to jump straight to its source.
                                    </span>
                                </div>

                                {/* 360° context sections (Option A polish, May 2026).
                                    Each section renders only when there's data,
                                    so a stale or thin node stays minimal. List
                                    items are buttons — clicking re-selects
                                    the target node so the user can walk the
                                    graph from the panel.
                                    V2.8 will replace these with cluster-aware
                                    callers/callees from the symbol-level call
                                    graph; for now this is the file-level
                                    neighborhood that the existing graphData
                                    actually carries. */}
                                {selectedNodeContext?.kind === 'file' && (
                                    <>
                                        {selectedNodeContext.importers.length > 0 && (
                                            <div className="nexus-graph-selected-card__section">
                                                <div className="nexus-graph-selected-card__section-title">
                                                    ◀ Imported by ({selectedNodeContext.importers.length})
                                                </div>
                                                <ul className="nexus-graph-selected-card__list">
                                                    {selectedNodeContext.importers.slice(0, 12).map(fp => (
                                                        <li key={fp}>
                                                            <button
                                                                type="button"
                                                                className="nexus-graph-selected-card__list-item"
                                                                onClick={() => setSelectedGraphNode({
                                                                    id: fp,
                                                                    name: fp.split('/').pop() || fp,
                                                                    group: 'file',
                                                                    filepath: fp,
                                                                })}
                                                                title={fp}
                                                            >📄 {fp.split('/').pop()}</button>
                                                        </li>
                                                    ))}
                                                    {selectedNodeContext.importers.length > 12 && (
                                                        <li className="nexus-graph-selected-card__list-overflow">
                                                            +{selectedNodeContext.importers.length - 12} more…
                                                        </li>
                                                    )}
                                                </ul>
                                            </div>
                                        )}

                                        {selectedNodeContext.importsResolved.length > 0 && (
                                            <div className="nexus-graph-selected-card__section">
                                                <div className="nexus-graph-selected-card__section-title">
                                                    ▶ Imports ({selectedNodeContext.importsResolved.length})
                                                </div>
                                                <ul className="nexus-graph-selected-card__list">
                                                    {selectedNodeContext.importsResolved.slice(0, 12).map(fp => (
                                                        <li key={fp}>
                                                            <button
                                                                type="button"
                                                                className="nexus-graph-selected-card__list-item"
                                                                onClick={() => setSelectedGraphNode({
                                                                    id: fp,
                                                                    name: fp.split('/').pop() || fp,
                                                                    group: 'file',
                                                                    filepath: fp,
                                                                })}
                                                                title={fp}
                                                            >📄 {fp.split('/').pop()}</button>
                                                        </li>
                                                    ))}
                                                    {selectedNodeContext.importsResolved.length > 12 && (
                                                        <li className="nexus-graph-selected-card__list-overflow">
                                                            +{selectedNodeContext.importsResolved.length - 12} more…
                                                        </li>
                                                    )}
                                                </ul>
                                            </div>
                                        )}

                                        {selectedNodeContext.externalImports.length > 0 && (
                                            <div className="nexus-graph-selected-card__section">
                                                <div className="nexus-graph-selected-card__section-title">
                                                    📦 External libraries ({selectedNodeContext.externalImports.length})
                                                </div>
                                                <div className="nexus-graph-selected-card__chip-row">
                                                    {selectedNodeContext.externalImports.slice(0, 8).map(name => (
                                                        <span key={name} className="nexus-graph-selected-card__chip">{name}</span>
                                                    ))}
                                                    {selectedNodeContext.externalImports.length > 8 && (
                                                        <span className="nexus-graph-selected-card__chip is-overflow">
                                                            +{selectedNodeContext.externalImports.length - 8}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {selectedNodeContext.symbols.length > 0 && (
                                            <div className="nexus-graph-selected-card__section">
                                                <div className="nexus-graph-selected-card__section-title">
                                                    ◆ Symbols in this file ({selectedNodeContext.symbols.length})
                                                </div>
                                                <ul className="nexus-graph-selected-card__list">
                                                    {selectedNodeContext.symbols.slice(0, 12).map(sym => (
                                                        <li key={`${sym.kind}::${sym.name}`}>
                                                            <button
                                                                type="button"
                                                                className="nexus-graph-selected-card__list-item"
                                                                onClick={() => setSelectedGraphNode({
                                                                    id: `${selectedNodeContext.filepath}::${sym.name}`,
                                                                    name: sym.name,
                                                                    group: sym.kind,
                                                                    filepath: selectedNodeContext.filepath,
                                                                    symbol: sym.name,
                                                                })}
                                                                title={`${sym.kind}: ${sym.name}`}
                                                            >
                                                                {sym.kind === 'class' ? '© ' : sym.kind === 'function' ? 'ƒ ' : '◆ '}
                                                                {sym.name}
                                                                {selectedNodeContext.exports.includes(sym.name) && (
                                                                    <span className="nexus-graph-selected-card__list-badge">exported</span>
                                                                )}
                                                            </button>
                                                        </li>
                                                    ))}
                                                    {selectedNodeContext.symbols.length > 12 && (
                                                        <li className="nexus-graph-selected-card__list-overflow">
                                                            +{selectedNodeContext.symbols.length - 12} more…
                                                        </li>
                                                    )}
                                                </ul>
                                            </div>
                                        )}
                                    </>
                                )}

                                {selectedNodeContext?.kind === 'symbol' && (
                                    <>
                                        <div className="nexus-graph-selected-card__section">
                                            <div className="nexus-graph-selected-card__meta-row">
                                                <span className="nexus-graph-selected-card__meta-label">Kind:</span>
                                                <span>{selectedNodeContext.symbolKind}</span>
                                            </div>
                                            {selectedNodeContext.isExported && (
                                                <div className="nexus-graph-selected-card__meta-row">
                                                    <span className="nexus-graph-selected-card__meta-label">Visibility:</span>
                                                    <span className="nexus-graph-selected-card__list-badge">exported</span>
                                                </div>
                                            )}
                                        </div>

                                        {selectedNodeContext.siblings.length > 0 && (
                                            <div className="nexus-graph-selected-card__section">
                                                <div className="nexus-graph-selected-card__section-title">
                                                    ◆ Other symbols in this file ({selectedNodeContext.siblings.length})
                                                </div>
                                                <ul className="nexus-graph-selected-card__list">
                                                    {selectedNodeContext.siblings.slice(0, 10).map(sym => (
                                                        <li key={`${sym.kind}::${sym.name}`}>
                                                            <button
                                                                type="button"
                                                                className="nexus-graph-selected-card__list-item"
                                                                onClick={() => setSelectedGraphNode({
                                                                    id: `${selectedNodeContext.filepath}::${sym.name}`,
                                                                    name: sym.name,
                                                                    group: sym.kind,
                                                                    filepath: selectedNodeContext.filepath,
                                                                    symbol: sym.name,
                                                                })}
                                                                title={`${sym.kind}: ${sym.name}`}
                                                            >
                                                                {sym.kind === 'class' ? '© ' : sym.kind === 'function' ? 'ƒ ' : '◆ '}
                                                                {sym.name}
                                                            </button>
                                                        </li>
                                                    ))}
                                                    {selectedNodeContext.siblings.length > 10 && (
                                                        <li className="nexus-graph-selected-card__list-overflow">
                                                            +{selectedNodeContext.siblings.length - 10} more…
                                                        </li>
                                                    )}
                                                </ul>
                                            </div>
                                        )}

                                        <div className="nexus-graph-selected-card__section">
                                            <div className="nexus-graph-selected-card__v2-hint">
                                                ⓘ Cross-file callers and callees ship in v2.8 (GitNexus-class symbol graph).
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}

                        {isGraphLoading && (
                            <div style={{ background: 'rgba(88, 166, 255, 0.1)', border: '1px solid rgba(88, 166, 255, 0.3)', borderRadius: '6px', padding: '10px', display: 'flex', gap: '10px', alignItems: 'center' }}>
                                <div style={{ color: '#58a6ff' }} className="spin">{Icons.Loader}</div>
                                <div style={{ fontSize: '11px', color: '#c9d1d9', lineHeight: '1.4' }}>
                                    <strong>{t("traceability.matrix_computing_label")}</strong> {t("traceability.matrix_computing")}
                                </div>
                            </div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                <div style={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--nexus-subtext)', textTransform: 'uppercase' }}>
                                    {activeMapType === 'codeMap' ? 'File Anatomy' : 'Relational Node Data'}
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--nexus-subtext)' }}>
                                    {activeMapType === 'combinedMap' && 'Showing Tasks & Vector Math'}
                                </div>
                            </div>

                            {/* 🚀 GLOBAL PROJECT TDD BUTTON */}
                            <button
                                onClick={() => vscode.postMessage({ type: 'generateProjectTests' })}
                                title={t("buttons.tdd_master_suite")}
                                style={{
                                    background: '#238636',
                                    border: '1px solid rgba(240, 246, 252, 0.1)',
                                    color: '#ffffff',
                                    borderRadius: '6px',
                                    padding: '6px 12px',
                                    cursor: 'pointer',
                                    fontSize: '12px',
                                    fontWeight: 'bold',
                                    boxShadow: '0 2px 5px rgba(0,0,0,0.2)'
                                }}
                            >
                                <span className="nexus-flex-row">{Icons.Flask} Generate Project TDD</span>
                            </button>
                        </div>

                        {!graphData ? null :
                            Array.isArray(graphData.nodes) ? (
                                graphData.nodes.length === 0 ? (
                                    <div style={{ textAlign: 'center', color: 'var(--nexus-subtext)', marginTop: '40px', padding: '20px', background: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
                                        No requirements found. Go to the <strong>Spec</strong> tab to generate a PRD and Implementation Plan first!
                                    </div>
                                ) : (
                                    graphData.nodes.map((node: any) => {
                                        // 1. Get Badge Styles based on Group
                                        const safeGroup = (node.group || node.type || 'file').toLowerCase();
                                        let badge = { bg: 'rgba(255,255,255,0.1)', color: '#ccc', icon: '🔹' };
                                        if (safeGroup === 'epic') { badge = { bg: 'rgba(245, 66, 141, 0.15)', color: '#f5428d', icon: '🎯' }; }
                                        if (safeGroup === 'story') { badge = { bg: 'rgba(81, 207, 102, 0.15)', color: '#51cf66', icon: '📖' }; }
                                        if (safeGroup === 'criteria') { badge = { bg: 'rgba(51, 154, 240, 0.15)', color: '#339af0', icon: '✅' }; }
                                        if (safeGroup === 'task') { badge = { bg: 'rgba(252, 163, 17, 0.15)', color: '#fca311', icon: '⚡' }; }
                                        if (safeGroup === 'file') { badge = { bg: 'rgba(139, 148, 158, 0.15)', color: '#8b949e', icon: '📄' }; }
                                        if (safeGroup === 'api') { badge = { bg: 'rgba(156, 39, 176, 0.15)', color: '#e0a8ff', icon: '🔌' }; }
                                        if (safeGroup === 'model') { badge = { bg: 'rgba(0, 188, 212, 0.15)', color: '#80deea', icon: '🗄️' }; }

                                        // 2. Extract Relational Connections (Safe for WebGL Object mutation)
                                        const edges = graphData.edges || [];
                                        const nodeEdges = edges.filter((e: any) => {
                                            const srcId = typeof e.source === 'object' ? e.source.id : e.source;
                                            const tgtId = typeof e.target === 'object' ? e.target.id : e.target;
                                            return srcId === node.id || tgtId === node.id;
                                        });

                                        return (
                                            <div key={node.id} id={`node-card-${node.id.replace(/[^a-zA-Z0-9-]/g, '-')}`} className="nexus-input-panel">

                                                {/* Header with Badge */}
                                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                                                    <span style={{ background: badge.bg, color: badge.color, padding: '2px 8px', borderRadius: '12px', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', flexShrink: 0, marginTop: '2px' }}>
                                                        {badge.icon} {node.group}
                                                    </span>
                                                    <div style={{ color: 'var(--vscode-foreground)', fontWeight: 'bold', fontSize: '13px', lineHeight: '1.4', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                                                        {node.label || node.id}
                                                    </div>
                                                </div>

                                                {/* System ID */}
                                                <div style={{ fontSize: '10px', color: 'var(--nexus-subtext)', marginTop: '8px', fontFamily: 'monospace', background: 'rgba(0,0,0,0.2)', padding: '4px', borderRadius: '4px', wordBreak: 'break-all' }}>
                                                    ID: {node.id}
                                                </div>

                                                {/* THE UPGRADE: Relational Connections & Vector Math */}
                                                {nodeEdges.length > 0 && (
                                                    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed var(--vscode-input-border)' }}>
                                                        <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--nexus-subtext)', marginBottom: '6px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>{Icons.Link} CONNECTIONS</div>
                                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                            {nodeEdges.map((edge: any, idx: number) => {
                                                                const srcId = typeof edge.source === 'object' ? edge.source.id : edge.source;
                                                                const tgtId = typeof edge.target === 'object' ? edge.target.id : edge.target;

                                                                const isOutgoing = srcId === node.id;
                                                                const connectedId = isOutgoing ? tgtId : srcId;

                                                                // Format the Math!
                                                                const isSemantic = edge.isSemantic;
                                                                const weight = edge.weight ? (edge.weight * 100).toFixed(1) + '%' : null;

                                                                return (
                                                                    <div key={idx} style={{ fontSize: '11px', color: 'var(--vscode-textLink-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.03)', padding: '4px 6px', borderRadius: '4px' }}>
                                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>
                                                                            <span style={{ color: 'var(--nexus-subtext)', flexShrink: 0 }}>{isOutgoing ? '→' : '←'}</span>
                                                                            <span title={connectedId} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{connectedId}</span>
                                                                        </div>

                                                                        {/* Render the Mathematical Cosine Similarity Score */}
                                                                        {isSemantic && weight && (
                                                                            <span style={{ color: '#fca311', fontWeight: 'bold', fontSize: '10px', background: 'rgba(252, 163, 17, 0.1)', padding: '2px 6px', borderRadius: '4px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                                                                {Icons.Brain} {weight} match
                                                                            </span>
                                                                        )}
                                                                        {!isSemantic && (
                                                                            <span style={{ color: '#51cf66', fontSize: '10px', opacity: 0.8, flexShrink: 0 }}>
                                                                                Hard Link
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })
                                )) : (
                                Object.entries(graphData).map(([filepath, node]: [string, any]) => {
                                    if (filepath === 'nodes' || filepath === 'edges') { return null; }
                                    const safeId = `node-card-${filepath.replace(/[^a-zA-Z0-9-]/g, '-')}`;

                                    //  THE FIX: Intelligently split the path for clean typography
                                    const isWindows = filepath.includes('\\');
                                    const parts = filepath.split(isWindows ? '\\' : '/');
                                    const fileName = parts.pop() || filepath;
                                    const dirName = parts.length > 0 ? parts.join(isWindows ? '\\' : '/') : '';

                                    return (
                                        <div id={safeId} key={filepath} className="nexus-input-panel">

                                            {/* Beautiful Header Layout */}
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                                                {/* 🚀 THE FIX: Added flex: 1 and minWidth: 0 to force the ellipsis to trigger */}
                                                <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingRight: '10px', flex: 1, minWidth: 0 }}>
                                                    <span style={{ color: 'var(--vscode-foreground)', fontWeight: 'bold', fontSize: '13px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', display: 'inline-flex', alignItems: 'center', gap: '6px' }} title={fileName}>
                                                        {Icons.File} {fileName}
                                                    </span>
                                                    {dirName && (
                                                        <span style={{ color: 'var(--nexus-subtext)', fontSize: '10px', marginTop: '2px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontFamily: 'monospace' }} title={dirName}>
                                                            {dirName}
                                                        </span>
                                                    )}
                                                </div>

                                                <button
                                                    style={{ background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', border: '1px solid var(--vscode-button-border, transparent)', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                                    title={t("buttons.open_in_editor")}
                                                    onClick={() => vscode.postMessage({ type: 'openFile', filepath: filepath })}>
                                                    OPEN {Icons.ExternalLink}
                                                </button>
                                            </div>

                                            {/* File Attributes */}
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '11px' }}>
                                                {node.exports?.length > 0 && (
                                                    <div style={{ background: 'rgba(81, 207, 102, 0.1)', color: '#51cf66', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(81, 207, 102, 0.3)' }}>
                                                        <strong>{t("node_details.exports_label")}</strong> {node.exports.join(', ')}
                                                    </div>
                                                )}
                                                {node.classes?.length > 0 && (
                                                    <div style={{ background: 'rgba(252, 163, 17, 0.1)', color: '#fca311', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(252, 163, 17, 0.3)' }}>
                                                        <strong>{t("node_details.classes_label")}</strong> {node.classes.join(', ')}
                                                    </div>
                                                )}
                                                {node.functions?.length > 0 && (
                                                    <div style={{ background: 'rgba(51, 154, 240, 0.1)', color: '#339af0', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(51, 154, 240, 0.3)' }}>
                                                        <strong>{t("node_details.functions_label")}</strong> {node.functions.join(', ')}
                                                    </div>
                                                )}
                                                {node.imports?.length > 0 && (
                                                    <div style={{ width: '100%', marginTop: '4px', color: 'var(--nexus-subtext)' }}>
                                                        ↳ Imports: {node.imports.map((imp: string) => imp.replace(/['"]/g, '')).join(', ')}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })
                            )
                        }
                    </div>
                </div>
            </div>

            {/* ========================================================= */}
            {/* ⏱️ TAB 5: TIMELINE (P3.1 telemetry retrospective)         */}
            {/* ========================================================= */}
            <div className="nexus-timeline-tab" style={{ display: activeTab === 'timeline' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                <TimelineView
                    incomingEvents={timelineEvents}
                    loading={timelineLoading}
                    onRefresh={() => {
                        setTimelineLoading(true);
                        vscode.postMessage({ type: 'getTimelineEvents' });
                    }}
                />
            </div>
        </AppShell>

        {/* V2.1.2b — scaffold confirmation dialog. Renders only when
            the reducer is in 'deciding' or 'failed' phase. Side effects
            (postMessage to host) live here rather than in the reducer
            so the reducer stays pure and unit-testable. */}
        {(scaffoldState.phase === 'deciding' || scaffoldState.phase === 'failed') && scaffoldState.decision && (
            <ScaffoldConfirmationDialog
                templates={scaffoldState.decision.templates}
                stackHint={scaffoldState.decision.stackHint}
                confidence={scaffoldState.decision.confidence}
                busy={false /* acknowledging phase clears the dialog;
                              from deciding/failed it's always interactive */}
                lastError={scaffoldState.lastError}
                onPick={(action, templateId) => {
                    dispatchScaffoldAction({ type: 'userPicked', action, templateId });
                    vscode.postMessage({
                        type: 'scaffoldDecisionMade',
                        action,
                        templateId,
                    });
                }}
                onCancel={() => {
                    dispatchScaffoldAction({ type: 'userPicked', action: 'cancel', templateId: null });
                    vscode.postMessage({
                        type: 'scaffoldDecisionMade',
                        action: 'cancel',
                        templateId: null,
                    });
                }}
            />
        )}
        </>
    );
}