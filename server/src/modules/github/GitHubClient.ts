/**
 * Минимальный клиент GitHub REST API для моста «задачи в issues → работа → pull request».
 * Токен: fine-grained PAT с доступом к одному репозиторию (Issues, Pull requests, Contents — read/write).
 */

export interface GitHubIssue {
    number: number;
    title: string;
    body: string;
    author: string;
    labels: string[];
    url: string;
    isPullRequest: boolean;
}

export interface GitHubComment {
    id: number;
    author: string;
    body: string;
    createdAt: string;
}

export interface GitHubPullRequest {
    number: number;
    url: string;
    head: string;
    state: string;
}

/** Метка в комментариях JustAI: так свои сообщения отличаются от сообщений человека с того же аккаунта. */
export const BOT_MARKER = "<!-- justai:bot -->";

export class GitHubError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = "GitHubError";
    }
}

export class GitHubClient {

    private readonly base: string;

    constructor(
        private readonly token: string,
        /** owner/name */
        public readonly repo: string,
        private readonly fetchImpl: typeof fetch = fetch,
        apiUrl = "https://api.github.com",
    ) {
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
            throw new Error(`Repository must look like owner/name, got "${repo}".`);
        }

        this.base = `${apiUrl.replace(/\/$/, "")}/repos/${repo}`;
    }

    public async currentUser(): Promise<string> {
        const user = await this.request<{ login: string }>(this.base.replace(/\/repos\/.*$/, "/user"));
        return user.login;
    }

    public async defaultBranch(): Promise<string> {
        const repo = await this.request<{ default_branch: string; private: boolean }>(this.base);
        return repo.default_branch;
    }

    public async isPrivate(): Promise<boolean> {
        const repo = await this.request<{ private: boolean }>(this.base);
        return repo.private;
    }

    /** Открытые issues (без label — все), старые первыми. */
    public async listIssues(label?: string): Promise<GitHubIssue[]> {
        const filter = label ? `&labels=${encodeURIComponent(label)}` : "";
        const items = await this.request<RawIssue[]>(`${this.base}/issues?state=open${filter}&per_page=100&sort=created&direction=asc`);
        return items.map(toIssue);
    }

    public async closeIssue(number: number): Promise<void> {
        await this.request(`${this.base}/issues/${number}`, { method: "PATCH", body: { state: "closed" } });
    }

    public async getIssue(number: number): Promise<GitHubIssue> {
        return toIssue(await this.request<RawIssue>(`${this.base}/issues/${number}`));
    }

    public async createIssue(title: string, body: string, labels: string[]): Promise<GitHubIssue> {
        return toIssue(await this.request<RawIssue>(`${this.base}/issues`, { method: "POST", body: { title, body, labels } }));
    }

    public async listComments(number: number): Promise<GitHubComment[]> {
        const items = await this.request<Array<{ id: number; user: { login: string } | null; body: string | null; created_at: string }>>(
            `${this.base}/issues/${number}/comments?per_page=100`,
        );

        return items.map(item => ({ id: item.id, author: item.user?.login ?? "", body: item.body ?? "", createdAt: item.created_at }));
    }

    /** Комментарий к issue; возвращает его id (чтобы потом обновлять, например отчёт о ходе работы). */
    public async comment(number: number, body: string, asBot = true): Promise<number> {
        const created = await this.request<{ id: number } | undefined>(`${this.base}/issues/${number}/comments`, { method: "POST", body: { body: asBot ? `${body}\n\n${BOT_MARKER}` : body } });
        return created?.id ?? 0;
    }

    public async updateComment(id: number, body: string): Promise<void> {
        await this.request(`${this.base}/issues/comments/${id}`, { method: "PATCH", body: { body: `${body}\n\n${BOT_MARKER}` } });
    }

    public async addLabels(number: number, labels: string[]): Promise<void> {
        await this.request(`${this.base}/issues/${number}/labels`, { method: "POST", body: { labels } });
    }

    public async removeLabel(number: number, label: string): Promise<void> {
        try {
            await this.request(`${this.base}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
        }
        catch (error) {
            if (!(error instanceof GitHubError && error.status === 404)) throw error;
        }
    }

    public async findPullRequest(head: string): Promise<GitHubPullRequest | null> {
        const owner = this.repo.split("/")[0]!;
        const items = await this.request<RawPull[]>(`${this.base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
        return items[0] ? toPull(items[0]) : null;
    }

    public async createPullRequest(head: string, base: string, title: string, body: string): Promise<GitHubPullRequest> {
        return toPull(await this.request<RawPull>(`${this.base}/pulls`, { method: "POST", body: { head, base, title, body } }));
    }

    /** Слить PR. 405 — не готов к слиянию (конфликт, обязательные проверки), 409 — ветка изменилась. */
    public async mergePullRequest(number: number, title: string, method: "squash" | "merge" | "rebase" = "squash"): Promise<void> {
        await this.request(`${this.base}/pulls/${number}/merge`, { method: "PUT", body: { merge_method: method, commit_title: title } });
    }

    public async deleteBranch(branch: string): Promise<void> {
        await this.request(`${this.base}/git/refs/heads/${refPath(branch)}`, { method: "DELETE" });
    }

    /** Дифф PR в формате unified diff (для ревью планировщиком). */
    public async pullRequestDiff(number: number): Promise<string> {
        return this.request<string>(`${this.base}/pulls/${number}`, { accept: "application/vnd.github.diff" });
    }

    /**
     * Файл в служебную ветку (например, скриншот для отчёта); ветки нет — создаётся от основной.
     * Возвращает адрес, по которому файл открывается из комментария.
     */
    public async uploadFile(branch: string, filePath: string, base64: string, message: string): Promise<string> {
        await this.ensureBranch(branch);

        const encoded = filePath.split("/").map(encodeURIComponent).join("/");
        await this.request(`${this.base}/contents/${encoded}`, { method: "PUT", body: { message, content: base64, branch } });

        return `https://github.com/${this.repo}/blob/${encodeURIComponent(branch)}/${encoded}?raw=true`;
    }

    private async ensureBranch(branch: string): Promise<void> {
        try {
            await this.request(`${this.base}/git/ref/heads/${refPath(branch)}`);
            return;
        }
        catch (error) {
            if (!(error instanceof GitHubError && error.status === 404)) throw error;
        }

        const base = await this.defaultBranch();
        const head = await this.request<{ object: { sha: string } }>(`${this.base}/git/ref/heads/${refPath(base)}`);
        await this.request(`${this.base}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: head.object.sha } });
    }

    private async request<T>(url: string, options: { method?: string; body?: unknown; accept?: string } = {}): Promise<T> {
        const response = await this.fetchImpl(url, {
            method: options.method ?? "GET",
            headers: {
                Authorization: `Bearer ${this.token}`,
                Accept: options.accept ?? "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "JustAI",
                ...(options.body ? { "Content-Type": "application/json" } : {}),
            },
            ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => "");
            let message = text;

            try {
                message = (JSON.parse(text) as { message?: string }).message ?? text;
            }
            catch {
                // не JSON
            }

            throw new GitHubError(response.status, `GitHub ${options.method ?? "GET"} ${url.replace(this.base, "")} → ${response.status}: ${message.slice(0, 300)}`);
        }

        if (response.status === 204) {
            return undefined as T;
        }

        return (options.accept?.includes("diff") ? await response.text() : await response.json()) as T;
    }
}

interface RawIssue {
    number: number;
    title: string;
    body: string | null;
    user: { login: string } | null;
    labels: Array<{ name: string } | string>;
    html_url: string;
    pull_request?: unknown;
}

interface RawPull {
    number: number;
    html_url: string;
    head: { ref: string };
    state: string;
}

function toIssue(raw: RawIssue): GitHubIssue {
    return {
        number: raw.number,
        title: raw.title,
        body: raw.body ?? "",
        author: raw.user?.login ?? "",
        labels: raw.labels.map(label => typeof label === "string" ? label : label.name),
        url: raw.html_url,
        isPullRequest: raw.pull_request !== undefined,
    };
}

function toPull(raw: RawPull): GitHubPullRequest {
    return { number: raw.number, url: raw.html_url, head: raw.head.ref, state: raw.state };
}

/** Имя ветки в пути API: слэши остаются (`justai/issue-5`), остальное кодируется. */
function refPath(branch: string): string {
    return branch.split("/").map(encodeURIComponent).join("/");
}
