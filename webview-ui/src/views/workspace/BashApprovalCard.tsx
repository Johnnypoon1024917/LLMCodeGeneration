// webview-ui/src/views/workspace/BashApprovalCard.tsx
//
// Bash command approval card — the third gate in NexusCode's
// command-execution security model. The first two gates are silent:
//
//   1. Static denylist (src/agents/commandDenylist.ts) — regex rules
//      catching rm-rf-root, fork bombs, curl|sh patterns etc. Blocks
//      hard, no LLM in the loop.
//   2. LLM Security Monitor — the agent's command + reasoning are
//      reviewed by a separate judge model that issues an allow/block.
//   3. THIS card — the user's final approval. Even after passing the
//      first two gates, the human is the last word.
//
// The card surfaces the command verbatim (no rewriting, no truncation —
// trust requires seeing exactly what would run), summarizes the prior
// verdicts as pills, and offers three actions:
//
//   - Block        — refuse this command
//   - Allow once   — run THIS command but prompt again next time
//   - Allow for this task — engage per-task autopilot. Subsequent
//     bash_exec calls in the same task skip the prompt. Resets at
//     the next user message.
//
// PR 2.3 (Sprint 2): extracted out of App.tsx (was the
// `nexus-bash-approval` block, ~75 lines of inline JSX with hardcoded
// rgba colors). Now uses the Card primitive + Pill + Button. Same
// message-protocol contracts (`respondBashApproval` with mode), same
// i18n keys. State stays in App.tsx — this component is purely
// presentational, fires actions via the onRespond callback.

import { useTranslation } from 'react-i18next';
import { Code as IconCode, ShieldCheck as IconShield } from 'lucide-react';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Pill } from '../../components/ui/Pill';
import { cn } from '../../components/ui/cn';

export type BashApprovalMode = 'block' | 'allow' | 'allow-always';

export interface BashApprovalCardProps {
    /** The shell command the agent wants to run. Rendered verbatim
     *  in a code block — never truncated, never rewritten. The user's
     *  ability to make an informed decision depends on seeing the
     *  exact string that would be passed to the shell. */
    command: string;
    /** Called when the user clicks one of the three actions. The
     *  caller is responsible for clearing pendingBashApproval state
     *  and posting the message to the host. */
    onRespond: (mode: BashApprovalMode) => void;
}

export function BashApprovalCard({ command, onRespond }: BashApprovalCardProps) {
    const { t } = useTranslation();

    return (
        <Card
            variant="alert"
            role="alert"
            className="mx-3 my-2"
        >
            <Card.Header tint="pending">
                <IconCode size={14} className="shrink-0" />
                <span className="flex-1">
                    {t('bash_approval.title') || 'Approve command?'}
                </span>
                {/* Verdict chips. Both prior gates are by definition green
                    by the time this card renders (it only appears AFTER
                    the static denylist allowed and the LLM judge allowed).
                    Showing them explicitly tells the user "the system
                    has already vouched, you're the third gate" — that
                    framing matters for compliance officers. */}
                <span className="hidden sm:inline-flex items-center gap-1.5">
                    <Pill variant="secure" className="text-[10px]">
                        <IconShield size={10} className="mr-1" />
                        denylist
                    </Pill>
                    <Pill variant="secure" className="text-[10px]">
                        <IconShield size={10} className="mr-1" />
                        monitor
                    </Pill>
                </span>
            </Card.Header>

            <Card.Body className="flex flex-col gap-2.5">
                <p className="text-xs text-text-secondary leading-relaxed m-0">
                    {t('bash_approval.body') ||
                        'The agent wants to run a shell command. It has passed the static denylist and the LLM Security Monitor; your approval is the final gate.'}
                </p>
                {/* Command preview. Verbatim, no escaping beyond what
                    React already does — wrapped in <pre><code> so screen
                    readers announce it as code. max-h prevents a malicious
                    very-long command from pushing the buttons off-screen,
                    but the content stays scrollable so nothing is hidden. */}
                <pre
                    className={cn(
                        'm-0 px-3 py-2',
                        'bg-surface-base border border-border-subtle rounded-sm',
                        'font-mono text-xs text-text-primary',
                        'whitespace-pre-wrap break-all',
                        'max-h-30 overflow-y-auto',
                        'tabular-nums'
                    )}
                >
                    <code>{command}</code>
                </pre>
            </Card.Body>

            <Card.Footer className="flex-wrap">
                <Button
                    variant="danger"
                    size="sm"
                    onClick={() => onRespond('block')}
                >
                    {t('bash_approval.block') || 'Block'}
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onRespond('allow')}
                >
                    {t('bash_approval.allow') || 'Allow once'}
                </Button>
                <Button
                    variant="primary"
                    size="sm"
                    onClick={() => onRespond('allow-always')}
                    title={
                        t('bash_approval.allow_always_tooltip') ||
                        'Allow all bash commands for this task. Resets at the next user message.'
                    }
                >
                    {t('bash_approval.allow_always') || 'Allow for this task'}
                </Button>
            </Card.Footer>
        </Card>
    );
}