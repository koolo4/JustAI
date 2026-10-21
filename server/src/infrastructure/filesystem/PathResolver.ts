import path from 'node:path';

import { isInside, resolveInside } from './safePath.js';

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

        return isInside(
            this.workspaceRoot,
            path.resolve(this.workspaceRoot, targetPath),
        );

    }

    /**
     * Преобразует относительный путь в абсолютный
     */
    public resolve(relativePath: string): string {

        return resolveInside(this.workspaceRoot, relativePath);

    }

    /**
     * Возвращает путь относительно workspace
     */
    public relative(absolutePath: string): string {

        return path.relative(this.workspaceRoot, absolutePath);

    }

}
