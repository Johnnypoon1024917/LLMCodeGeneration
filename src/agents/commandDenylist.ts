// src/agents/commandDenylist.ts
//
// V2.1.2 spec-fix-8: deterministic command pattern denylist.
//
// This is the first of three security gates the agent's bash tool runs
// through before executing. The other two are the LLM security monitor
// (askSecurityMonitorVerbose) and the user-confirmation dialog. The
// denylist is the cheap, fast, deterministic gate that fires before
// any model call.
//
// Why deterministic patterns first:
//   1. Speed — microseconds vs ~500ms for an LLM call.
//   2. Auditability — security review can read this file end-to-end
//      and reason about the blast radius. No opaque model behavior.
//   3. Adversarial robustness — a regex can't be social-engineered.
//      The LLM judge can be tricked by clever phrasing; the regex
//      doesn't care about phrasing.
//
// Patterns are ordered by destructiveness — first-match wins so the
// audit log carries the most relevant rule name. Each pattern is
// documented with rationale + an example of what it catches and
// what it explicitly does NOT catch (false-positive boundary).
//
// What this denylist is NOT for:
//   - Sophisticated obfuscation (e.g. base64-encoded rm -rf /). The
//     LLM judge handles those.
//   - Workspace-relative actions (rm -rf node_modules, etc). Those
//     are legitimate developer commands.
//   - Anything project-specific. This file knows nothing about the
//     user's repo.
//
// The bar for inclusion: a regex match here means the command is
// destructive enough that no legitimate development workflow would
// run it as written. False positives here are far worse than false
// negatives — the LLM judge is the safety net for things this misses.

export type DenylistVerdict =
    | { kind: 'allow' }
    | { kind: 'deny'; reason: string; pattern: string };

/**
 * One denylist rule. `name` shows up in audit logs and security banner
 * messages, so it must be human-readable and stable (don't rename
 * without coordinating with the audit-log readers).
 *
 * `match` returns the matched substring on a hit, null on a miss. We
 * use a function rather than a bare RegExp so multi-step rules (e.g.
 * "shell pipe to network fetch") can compose two checks.
 */
interface Rule {
    name: string;
    reason: string;
    match: (cmd: string) => string | null;
}

// Whitespace-tolerant alternation: matches `\s+` between tokens so
// `rm  -rf  /` and `rm\t-rf\t/` both hit. Used by several rules below.
const ws = '\\s+';

/**
 * Helper: build a regex that requires a command to start with a token
 * (after any leading whitespace, sudo, or env prefix). Avoids matching
 * `# rm -rf /` in a comment or `echo "rm -rf /"` in an echo string.
 *
 * The leading anchor accepts:
 *   - Start of string
 *   - After `&&`, `||`, `;`, `|`, or pipe-fed command boundaries
 *   - After `sudo` (so we still catch `sudo rm -rf /` even though sudo
 *     is itself denied below — order of rules matters)
 */
function startsCommand(token: string): RegExp {
    return new RegExp(`(?:^|[;&|]\\s*|sudo${ws})${token}\\b`, 'i');
}

const RULES: Rule[] = [
    // ──────────────────────────────────────────────────────────────────
    // 1. RECURSIVE DELETE on root or sensitive system paths
    // ──────────────────────────────────────────────────────────────────
    //
    // Catches: rm -rf /, rm -rf /*, rm -rf $HOME, rm -rf ~, rm -rf /etc
    // Misses:  rm -rf ./build, rm -rf node_modules, rm -rf src/dist
    //          (those are legitimate workspace cleanups)
    //
    // The pattern requires `-r` (or `-R` or `--recursive`) AND `-f` (or
    // `--force`) flags to match — `rm /etc/hosts` (no flags) doesn't
    // hit this rule. Single-file deletes outside the workspace are
    // a separate concern handled by the LLM judge.
    {
        name: 'rm-rf-root',
        reason: 'Recursive forced delete of root or sensitive system path.',
        match: (cmd) => {
            // Must contain rm with both recursive and force flags
            const hasRecursive = /\b(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive)\b/.test(cmd);
            const hasRm = /\brm\b/.test(cmd);
            if (!hasRecursive || !hasRm) { return null; }

            // Now check for dangerous targets. Each pattern matches a
            // path that should never be the target of a recursive delete.
            const dangerous = [
                /\brm[^|;&\n]*\s+\/(\s|$|\*|\/)/,        // rm ... /
                /\brm[^|;&\n]*\s+\/\*/,                   // rm ... /*
                /\brm[^|;&\n]*\s+\$HOME\b/,               // rm ... $HOME
                /\brm[^|;&\n]*\s+~(\s|$|\/)/,             // rm ... ~
                /\brm[^|;&\n]*\s+\/etc\b/,                // rm ... /etc
                /\brm[^|;&\n]*\s+\/usr\b/,                // rm ... /usr
                /\brm[^|;&\n]*\s+\/var\b/,                // rm ... /var
                /\brm[^|;&\n]*\s+\/bin\b/,                // rm ... /bin
                /\brm[^|;&\n]*\s+\/boot\b/,               // rm ... /boot
                /\brm[^|;&\n]*\s+\/sys\b/,                // rm ... /sys
                /\brm[^|;&\n]*\s+\/proc\b/,               // rm ... /proc
                /\brm[^|;&\n]*\s+\/dev\b/,                // rm ... /dev
                /\brm[^|;&\n]*\s+C:\\?\\?(\s|$)/i,        // rm ... C:\ (Windows)
                /\brm[^|;&\n]*\s+%USERPROFILE%/i,         // rm ... %USERPROFILE% (Windows)
            ];
            for (const re of dangerous) {
                const m = re.exec(cmd);
                if (m) { return m[0]; }
            }
            return null;
        },
    },

    // ──────────────────────────────────────────────────────────────────
    // 2. DISK WIPE / PARTITION MANIPULATION
    // ──────────────────────────────────────────────────────────────────
    //
    // Catches: dd if=... of=/dev/sda, mkfs, fdisk, parted, wipefs
    // Misses:  dd if=foo.iso of=foo.bin (file-to-file, no /dev/)
    {
        name: 'disk-wipe',
        reason: 'Direct disk or partition manipulation.',
        match: (cmd) => {
            const patterns = [
                /\bdd\s+[^|;&\n]*\bof=\/dev\/(sd|nvme|hd|xvd|vd)/i,  // dd of=/dev/sdX
                /\bmkfs(\.|\b)/i,                                     // mkfs, mkfs.ext4
                /\bfdisk\b/i,                                          // fdisk
                /\bparted\b/i,                                         // parted
                /\bwipefs\b/i,                                         // wipefs
                /\bshred\s+[^|;&\n]*\/dev\//,                          // shred /dev/X
            ];
            for (const re of patterns) {
                const m = re.exec(cmd);
                if (m) { return m[0]; }
            }
            return null;
        },
    },

    // ──────────────────────────────────────────────────────────────────
    // 3. FORK BOMB / RESOURCE EXHAUSTION
    // ──────────────────────────────────────────────────────────────────
    //
    // Catches: :(){ :|:& };:  — the classic bash fork bomb
    //          while true; do <fork>; done
    //          forkbomb-style :|: piping
    {
        name: 'fork-bomb',
        reason: 'Fork bomb pattern that exhausts process table.',
        match: (cmd) => {
            const patterns = [
                /:\(\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;\s*:/,         // classic :(){ :|:& };:
                /\bwhile\s+true\s*;\s*do\s+[a-zA-Z_]+\s*&\s*done/,  // while true; do X &; done
            ];
            for (const re of patterns) {
                const m = re.exec(cmd);
                if (m) { return m[0]; }
            }
            return null;
        },
    },

    // ──────────────────────────────────────────────────────────────────
    // 4. NETWORK EXFIL / REMOTE SHELL
    // ──────────────────────────────────────────────────────────────────
    //
    // Catches: curl ... | sh, wget ... | bash, nc -e /bin/sh
    // Misses:  curl https://api.example.com (no pipe to shell)
    //          wget -O file.tar.gz (downloads to file, no execution)
    //
    // The pattern is "fetch from network, pipe to shell" — the
    // canonical "trust nothing, run everything" one-liner.
    {
        name: 'network-shell-pipe',
        reason: 'Piping network-fetched content directly into a shell interpreter.',
        match: (cmd) => {
            const patterns = [
                /\b(curl|wget|fetch)\b[^|;&\n]*\|\s*(bash|sh|zsh|dash|ksh|python|python3|perl|ruby|node)\b/i,
                /\bnc\b[^|;&\n]*-[a-zA-Z]*e\b[^|;&\n]*\/bin\/(sh|bash)/i,  // nc -e /bin/sh
                /\bbash\s+<\s*\(\s*curl\b/i,                                // bash <(curl ...)
                /\bsh\s+<\s*\(\s*curl\b/i,                                  // sh <(curl ...)
            ];
            for (const re of patterns) {
                const m = re.exec(cmd);
                if (m) { return m[0]; }
            }
            return null;
        },
    },

    // ──────────────────────────────────────────────────────────────────
    // 5. PRIVILEGE ESCALATION
    // ──────────────────────────────────────────────────────────────────
    //
    // The agent should never elevate. If a task genuinely needs root
    // (npm install -g, system package install), the user runs that
    // themselves outside the agent.
    //
    // Catches: sudo X, su -c X, doas X, runas X
    // Misses:  pseudo-, sudoku, sudo_token (substring boundaries)
    {
        name: 'privilege-escalation',
        reason: 'Agent must not elevate privileges.',
        match: (cmd) => {
            const patterns = [
                startsCommand('sudo'),
                startsCommand('doas'),
                /^\s*su\s+(-c|-)/,                  // su -c "..."  or  su - user
                startsCommand('runas'),
                startsCommand('pkexec'),
            ];
            for (const re of patterns) {
                const m = re.exec(cmd);
                if (m) { return m[0]; }
            }
            return null;
        },
    },

    // ──────────────────────────────────────────────────────────────────
    // 6. SYSTEM POWER STATE
    // ──────────────────────────────────────────────────────────────────
    //
    // Catches: shutdown, reboot, halt, poweroff, init 0/6
    // No legitimate coding workflow asks for these.
    {
        name: 'system-power',
        reason: 'System shutdown / reboot / halt is never a development task.',
        match: (cmd) => {
            const patterns = [
                startsCommand('shutdown'),
                startsCommand('reboot'),
                startsCommand('halt'),
                startsCommand('poweroff'),
                /\binit\s+[06]\b/,  // init 0 (halt), init 6 (reboot)
                /\bsystemctl\s+(halt|reboot|poweroff|shutdown)\b/i,
            ];
            for (const re of patterns) {
                const m = re.exec(cmd);
                if (m) { return m[0]; }
            }
            return null;
        },
    },

    // ──────────────────────────────────────────────────────────────────
    // 7. CREDENTIAL EXFILTRATION
    // ──────────────────────────────────────────────────────────────────
    //
    // Reading credential stores is never something a coding agent
    // legitimately needs to do. If this fires, something is wrong.
    //
    // Catches: cat /etc/shadow, cat ~/.ssh/id_*, cat ~/.aws/credentials
    // Misses:  cat ~/.ssh/known_hosts (public; not a credential)
    //          cat ~/.aws/config (config, not credential)
    {
        name: 'credential-read',
        reason: 'Reading from credential / private-key files.',
        match: (cmd) => {
            const patterns = [
                /\b(cat|less|more|head|tail|tac|nl|od|hexdump|xxd)\b[^|;&\n]*\/etc\/shadow\b/i,
                /\b(cat|less|more|head|tail|tac|nl|od|hexdump|xxd)\b[^|;&\n]*\/etc\/sudoers/i,
                /\b(cat|less|more|head|tail|tac|nl|od|hexdump|xxd)\b[^|;&\n]*~\/\.ssh\/id_/i,
                /\b(cat|less|more|head|tail|tac|nl|od|hexdump|xxd)\b[^|;&\n]*\$HOME\/\.ssh\/id_/i,
                /\b(cat|less|more|head|tail|tac|nl|od|hexdump|xxd)\b[^|;&\n]*~\/\.aws\/credentials/i,
                /\b(cat|less|more|head|tail|tac|nl|od|hexdump|xxd)\b[^|;&\n]*\$HOME\/\.aws\/credentials/i,
                /\b(cat|less|more|head|tail|tac|nl|od|hexdump|xxd)\b[^|;&\n]*~\/\.netrc\b/i,
                /\b(cat|less|more|head|tail|tac|nl|od|hexdump|xxd)\b[^|;&\n]*~\/\.gnupg\//i,
            ];
            for (const re of patterns) {
                const m = re.exec(cmd);
                if (m) { return m[0]; }
            }
            return null;
        },
    },

    // ──────────────────────────────────────────────────────────────────
    // 8. GIT HISTORY REWRITING ON PROTECTED BRANCHES
    // ──────────────────────────────────────────────────────────────────
    //
    // Force-pushing to main/master is destructive and almost never
    // legitimate from an automated agent. If the user's workflow truly
    // requires this, they run it themselves.
    //
    // Catches: git push --force origin main, git push -f origin master,
    //          git push --force-with-lease origin main
    // Misses:  git push --force feature-branch (working branch is fine)
    //          git push origin main (non-force is fine)
    {
        name: 'git-force-push-protected',
        reason: 'Force-pushing to a protected branch (main/master/release).',
        match: (cmd) => {
            const re = /\bgit\s+push\s+(?:--force(?:-with-lease)?|-f)\b[^|;&\n]*\b(main|master|release\/[^\s]+|trunk|develop|production)\b/i;
            const m = re.exec(cmd);
            return m ? m[0] : null;
        },
    },
];

/**
 * Evaluate a command against the denylist. Returns 'allow' on no match,
 * or 'deny' with the matching rule's name + reason. First-match wins.
 */
export function evaluateCommand(cmd: string): DenylistVerdict {
    if (typeof cmd !== 'string' || cmd.trim() === '') {
        // Empty / non-string commands are not actionable; let the
        // dispatcher handle them. We return 'allow' here rather than
        // 'deny' because the LLM judge will catch malformed inputs.
        return { kind: 'allow' };
    }

    for (const rule of RULES) {
        const matched = rule.match(cmd);
        if (matched !== null) {
            return {
                kind: 'deny',
                reason: rule.reason,
                pattern: rule.name,
            };
        }
    }
    return { kind: 'allow' };
}

/**
 * Diagnostic helper: returns the names of all configured rules. Used
 * by the audit / settings UI to show users what's being blocked.
 * Stable across versions — adding a rule is non-breaking; removing
 * one requires a deprecation note in the changelog.
 */
export function listDenylistRules(): { name: string; reason: string }[] {
    return RULES.map(r => ({ name: r.name, reason: r.reason }));
}