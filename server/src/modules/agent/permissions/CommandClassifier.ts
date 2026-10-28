/**
 * Классификация команд оболочки для PermissionGate (MASTER_PLAN, раздел 6.3).
 *
 * safe      — известная безопасная команда (тесты, сборка, чтение, git status/diff);
 * unknown   — нельзя доказать безопасность (произвольные программы, подстановки, запись через >);
 * dangerous — разрушительные или выходящие за пределы проекта действия: подтверждение требуется всегда.
 *
 * Классификатор консервативен: при сомнении — unknown, а не safe.
 */

export type CommandLevel = "safe" | "unknown" | "dangerous";

export interface CommandClassification {
    level: CommandLevel;
    reason: string;
    /** Все части команды разрешены правилами проекта (явное решение пользователя). */
    allowedByRule?: boolean;
}

export interface CommandRules {
    /** Префиксы команд, разрешённые пользователем (например "npm run e2e"). */
    allow: string[];
    /** Префиксы или фрагменты, которые всегда требуют подтверждения. */
    deny: string[];
}

const DANGEROUS: Array<{ pattern: RegExp; reason: string }> = [
    // «git rm -r --cached node_modules» только убирает файлы из индекса (так чистят PR от зависимостей) — не удаление.
    { pattern: /(?<!\bgit\s+)\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, reason: "recursive or forced delete (rm -r/-f)" },
    { pattern: /\bgit\s+rm\b(?![^;|&]*--cached)/i, reason: "deletes tracked files (git rm without --cached)" },
    { pattern: /\bremove-item\b[^|;]*-(recurse|r\b|force)/i, reason: "recursive or forced delete (Remove-Item)" },
    { pattern: /\b(rd|rmdir)\s+\/s\b/i, reason: "recursive delete (rd /s)" },
    { pattern: /\bdel\s+(\/[a-z]\s+)*\/[sq]\b/i, reason: "recursive delete (del /s)" },
    { pattern: /\bgit\s+push\b/i, reason: "publishes commits (git push)" },
    { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "discards local changes (git reset --hard)" },
    { pattern: /\bgit\s+clean\s+-[a-z]*f/i, reason: "deletes untracked files (git clean -f)" },
    { pattern: /\bgit\s+checkout\s+(--\s|\.\s*$|-f\b)/i, reason: "discards local changes (git checkout)" },
    { pattern: /\bgit\s+restore\b/i, reason: "discards local changes (git restore)" },
    { pattern: /\bgit\s+(branch\s+-D|stash\s+(drop|clear)|rebase|filter-branch)\b/i, reason: "rewrites or deletes git history" },
    { pattern: /\b(shutdown|restart-computer|stop-computer|reboot|halt|poweroff)\b/i, reason: "shuts down or restarts the computer" },
    { pattern: /\b(format(-volume)?|diskpart|mkfs(\.\w+)?|bcdedit|fdisk)\b/i, reason: "disk or boot configuration" },
    { pattern: /\bdd\s+if=/i, reason: "raw disk write (dd)" },
    { pattern: /\breg(\.exe)?\s+(add|delete|import)\b/i, reason: "modifies the Windows registry" },
    { pattern: /\b(set-itemproperty|new-itemproperty|remove-itemproperty)\b[^;|]*\b(hklm|hkcu|registry::)/i, reason: "modifies the Windows registry" },
    { pattern: /\bset-executionpolicy\b/i, reason: "changes PowerShell security policy" },
    { pattern: /\b(sudo|runas|su)\b/i, reason: "runs with elevated privileges" },
    { pattern: /\b(netsh|schtasks|sc(\.exe)?\s+(create|delete|config)|new-service|set-service)\b/i, reason: "changes system services or network configuration" },
    { pattern: /\bnpm\s+(i|install|add)\b[^;|&]*\s(-g|--global)\b/i, reason: "installs a global package" },
    { pattern: /\b(pnpm|yarn)\s+(global\s+add|add\s+-g)\b/i, reason: "installs a global package" },
    { pattern: /\bpip3?\s+install\b(?![^;|&]*(-r\s|--requirement|-e\s|\.\s*$))/i, reason: "installs a Python package from the internet" },
    { pattern: /\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b[^;]*\|\s*(sh|bash|zsh|iex|invoke-expression|python3?|node)\b/i, reason: "downloads and executes a script" },
    { pattern: /\bchmod\s+-r\b|\bchown\s+-r\b/i, reason: "recursive permission change" },
    { pattern: /\bkill(all)?\s+-9\s+-?1\b|\btaskkill\b[^;|]*\/im\b/i, reason: "kills processes by name or all processes" },
    { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: "fork bomb" },
];

/** Префиксы безопасных команд (по токенам, без учёта регистра). */
const SAFE_PREFIXES: string[][] = [
    // чтение и навигация
    ["ls"], ["dir"], ["pwd"], ["cat"], ["type"], ["head"], ["tail"], ["wc"], ["echo"], ["which"], ["where"],
    ["get-childitem"], ["gci"], ["get-content"], ["gc"], ["get-location"], ["write-output"], ["write-host"],
    ["test-path"], ["get-item"], ["get-command"], ["select-string"], ["measure-object"], ["sort-object"],
    ["select-object"], ["where-object"], ["format-table"], ["format-list"], ["out-string"],
    ["rg"], ["grep"], ["find"], ["tree"],
    // версии
    ["node", "--version"], ["node", "-v"], ["npm", "--version"], ["npm", "-v"], ["git", "--version"],
    ["python", "--version"], ["python3", "--version"], ["dotnet", "--version"], ["go", "version"],
    // git только на чтение
    ["git", "status"], ["git", "diff"], ["git", "log"], ["git", "show"], ["git", "branch"], ["git", "rev-parse"],
    ["git", "ls-files"], ["git", "blame"], ["git", "remote", "-v"],
    // JavaScript / TypeScript
    ["npm", "test"], ["npm", "t"], ["npm", "run", "test"], ["npm", "run", "lint"], ["npm", "run", "typecheck"],
    ["npm", "run", "type-check"], ["npm", "run", "build"], ["npm", "run", "check"], ["npm", "run", "format:check"],
    ["npm", "ls"], ["npm", "outdated"], ["npm", "ci"], ["npm", "install"], ["npm", "i"],
    ["pnpm", "test"], ["pnpm", "run", "test"], ["pnpm", "run", "lint"], ["pnpm", "run", "build"], ["pnpm", "install"],
    ["yarn", "test"], ["yarn", "lint"], ["yarn", "build"], ["yarn", "install"],
    ["npx", "tsc"], ["npx", "vitest", "run"], ["npx", "jest"], ["npx", "eslint"], ["npx", "prettier", "--check"],
    ["tsc"], ["vitest", "run"], ["jest"], ["eslint"],
    // Python
    ["pytest"], ["python", "-m", "pytest"], ["python3", "-m", "pytest"], ["python", "-m", "unittest"],
    ["ruff", "check"], ["mypy"], ["python", "-m", "mypy"],
    // Rust / Go / .NET / JVM
    ["cargo", "test"], ["cargo", "check"], ["cargo", "build"], ["cargo", "clippy"], ["cargo", "fmt", "--check"],
    ["go", "test"], ["go", "build"], ["go", "vet"],
    ["dotnet", "test"], ["dotnet", "build"], ["dotnet", "restore"],
    ["mvn", "test"], ["mvn", "-q", "test"], ["gradle", "test"], ["./gradlew", "test"], [".\\gradlew", "test"],
];

/** Команды установки: безопасны только без имён пакетов (ставят зависимости из манифеста). */
const INSTALL_COMMANDS = new Set(["npm install", "npm i", "npm ci", "pnpm install", "yarn install", "dotnet restore"]);

/** Вложенные оболочки: их аргумент разбирается рекурсивно. */
const NESTED_SHELLS: Array<{ shell: RegExp; flag: RegExp }> = [
    { shell: /^(cmd|cmd\.exe)$/i, flag: /^\/[ck]$/i },
    { shell: /^(powershell|powershell\.exe|pwsh|pwsh\.exe)$/i, flag: /^-(c|command|encodedcommand|e|ec)$/i },
    { shell: /^(bash|sh|zsh|dash)$/i, flag: /^-[a-z]*c$/i },
];

export function classifyCommand(
    command: string,
    rules: CommandRules = { allow: [], deny: [] },
    depth = 0,
): CommandClassification {
    const normalized = command.trim();

    if (!normalized) {
        return { level: "unknown", reason: "empty command" };
    }

    for (const fragment of rules.deny) {
        if (fragment && normalized.toLowerCase().includes(fragment.toLowerCase())) {
            return { level: "dangerous", reason: `matches a project deny rule "${fragment}"` };
        }
    }

    for (const { pattern, reason } of DANGEROUS) {
        if (pattern.test(normalized)) {
            return { level: "dangerous", reason };
        }
    }

    if (depth > 3) {
        return { level: "unknown", reason: "deeply nested shell" };
    }

    // Подстановки команд и Invoke-Expression нельзя проверить статически.
    if (/\$\(|`[^`]*`|<\(|\b(iex|invoke-expression|start-process|saps)\b/i.test(normalized)) {
        return { level: "unknown", reason: "contains command substitution or dynamic execution" };
    }

    const results = splitSegments(normalized).map(segment => classifySegment(segment, rules, depth));

    const dangerous = results.find(result => result.level === "dangerous");

    if (dangerous) {
        return dangerous;
    }

    const unknown = results.find(result => result.level === "unknown");

    if (unknown) {
        return unknown;
    }

    return {
        level: "safe",
        reason: results[0]?.reason ?? "known safe command",
        allowedByRule: results.length > 0 && results.every(result => result.allowedByRule === true),
    };
}

function classifySegment(
    segment: string,
    rules: CommandRules,
    depth: number,
): CommandClassification {
    // Запись в файл через перенаправление: опасно за пределами проекта, проверить нельзя.
    const withoutHarmless = segment.replace(/\d?>\s*(\$null|\/dev\/null|nul)\b|\d>&\d/gi, "");

    if (/>/.test(withoutHarmless)) {
        return { level: "unknown", reason: "writes output to a file via redirection" };
    }

    let tokens = tokenize(segment);

    // PowerShell: оператор вызова & "program.exe" …
    if (tokens[0] === "&" || tokens[0] === ".") {
        tokens = tokens.slice(1);
    }

    if (tokens.length === 0) {
        return { level: "safe", reason: "empty segment" };
    }

    const [program, flag, ...rest] = tokens;

    for (const nested of NESTED_SHELLS) {
        if (program && nested.shell.test(program)) {
            if (flag && nested.flag.test(flag)) {
                if (/^-(encodedcommand|e|ec)$/i.test(flag)) {
                    return { level: "unknown", reason: "encoded PowerShell command" };
                }

                const inner = classifyCommand(rest.join(" "), rules, depth + 1);
                return { ...inner, reason: `${inner.reason} (inside ${program})` };
            }

            return { level: "unknown", reason: `starts a ${program} shell` };
        }
    }

    const lower = tokens.map(token => token.toLowerCase());

    for (const prefix of rules.allow) {
        const prefixTokens = tokenize(prefix).map(token => token.toLowerCase());

        if (prefixTokens.length > 0 && startsWith(lower, prefixTokens)) {
            return { level: "safe", reason: `allowed by project rule "${prefix}"`, allowedByRule: true };
        }
    }

    for (const prefix of SAFE_PREFIXES) {
        if (startsWith(lower, prefix)) {
            // Установка зависимостей проекта — да; новых пакетов из интернета (их postinstall-скрипты) — нет.
            if (INSTALL_COMMANDS.has(prefix.join(" ")) && lower.slice(prefix.length).some(token => !token.startsWith("-"))) {
                return { level: "unknown", reason: "installs new packages from the internet" };
            }

            return { level: "safe", reason: `known safe command (${prefix.join(" ")})` };
        }
    }

    return { level: "unknown", reason: `"${tokens.slice(0, 3).join(" ")}" is not on the safe list` };
}

function startsWith(tokens: string[], prefix: string[]): boolean {
    return prefix.every((part, index) => tokens[index] === part);
}

/**
 * Делит команду на части по ; && || | & и переводам строк вне кавычек.
 * Одиночный & в начале части — оператор вызова PowerShell, а не разделитель.
 */
export function splitSegments(command: string): string[] {
    const segments: string[] = [];
    let current = "";
    let quote: string | null = null;

    for (let i = 0; i < command.length; i += 1) {
        const char = command[i]!;
        const next = command[i + 1];

        if (quote) {
            current += char;
            if (char === quote) {
                quote = null;
            }
            continue;
        }

        if (char === "\"" || char === "'") {
            quote = char;
            current += char;
            continue;
        }

        // 2>&1 и &> — перенаправление, а не разделитель.
        if (char === "&" && (command[i - 1] === ">" || next === ">")) {
            current += char;
            continue;
        }

        const isDouble = (char === "&" || char === "|") && next === char;

        if (isDouble || char === ";" || char === "\n" || char === "|" || (char === "&" && current.trim() !== "")) {
            segments.push(current);
            current = "";
            if (isDouble) {
                i += 1;
            }
            continue;
        }

        current += char;
    }

    segments.push(current);

    return segments.map(segment => segment.trim()).filter(Boolean);
}

/** Простая токенизация с учётом кавычек (кавычки снимаются). */
export function tokenize(segment: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let quote: string | null = null;
    let started = false;

    for (const char of segment) {
        if (quote) {
            if (char === quote) {
                quote = null;
            }
            else {
                current += char;
            }
            continue;
        }

        if (char === "\"" || char === "'") {
            quote = char;
            started = true;
            continue;
        }

        if (/\s/.test(char)) {
            if (started) {
                tokens.push(current);
                current = "";
                started = false;
            }
            continue;
        }

        current += char;
        started = true;
    }

    if (started) {
        tokens.push(current);
    }

    return tokens;
}
