import { promises as fs } from 'node:fs';
import path from 'node:path';

export class IgnoreService {

    private readonly ignored = new Set<string>([
        '.git',
        'node_modules',
        'dist',
        'build',
        '.next',
        '.idea',
        '.vscode',
        '.DS_Store',
        'coverage',
        'tests',
    ]);

    constructor(
        private readonly workspaceRoot: string,
    ) {}

    public async initialize(): Promise<void> {

        const gitignore = path.join(
            this.workspaceRoot,
            '.gitignore',
        );

        try {

            const content = await fs.readFile(
                gitignore,
                'utf8',
            );

            for (const line of content.split('\n')) {

                const rule = line.trim();

                if (
                    rule.length === 0 ||
                    rule.startsWith('#')
                ) {
                    continue;
                }

                this.ignored.add(rule);

            }

        }
        catch {
            // .gitignore отсутствует — это нормально
        }

    }

    public shouldIgnore(name: string): boolean {

        return this.ignored.has(name);

    }

    public getRules(): string[] {

        return [...this.ignored];

    }

}