import path from 'node:path';

import { ForbiddenError } from '../../core/errors/ForbiddenError.js';

export class PathResolver {

    constructor(
        private readonly workspaceRoot: string,
    ) {}

    /**
     * Абсолютный путь до workspace
     */
    public getRoot(): string {
        return this.workspaceRoot;
    }

    /**
     * Проверяет, что путь находится внутри workspace
     */
    public isInsideWorkspace(targetPath: string): boolean {

        const absolute = path.resolve(this.workspaceRoot, targetPath);

        return absolute.startsWith(this.workspaceRoot);

    }

    /**
     * Преобразует относительный путь в абсолютный
     */
    public resolve(relativePath: string): string {

        const absolute = path.resolve(this.workspaceRoot, relativePath);

        if (!absolute.startsWith(this.workspaceRoot)) {
            throw new ForbiddenError(
                'Access outside workspace is forbidden.'
            );
        }

        return absolute;

    }

    /**
     * Возвращает путь относительно workspace
     */
    public relative(absolutePath: string): string {

        return path.relative(this.workspaceRoot, absolutePath);

    }

}