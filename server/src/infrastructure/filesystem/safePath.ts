import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { ForbiddenError } from '../../core/errors/ForbiddenError.js';

export type PathAccess = 'read' | 'write';

/**
 * Папки, к которым агент не имеет доступа.
 * .justai хранит сессии, токены и снапшоты; .git меняется только через GitService.
 */
const DENIED: Record<PathAccess, string[]> = {
    read: ['.justai'],
    write: ['.justai', '.git'],
};

/**
 * Лексическая проверка вложенности через path.relative.
 * В отличие от startsWith, не пропускает соседние папки с общим префиксом
 * ("C:\\work\\app-evil" для корня "C:\\work\\app").
 */
export function isInside(root: string, absolute: string): boolean {
    const relative = path.relative(root, absolute);

    return (
        relative === '' ||
        (
            relative !== '..' &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)
        )
    );
}

/**
 * Синхронное разрешение пути внутри workspace без проверки симлинков.
 */
export function resolveInside(root: string, target: string): string {
    const absolute = path.resolve(root, target);

    if (!isInside(root, absolute)) {
        throw new ForbiddenError('Access outside workspace is forbidden.');
    }

    return absolute;
}

/**
 * Полная проверка для инструментов агента:
 * вложенность, запрещённые папки и симлинки, ведущие наружу.
 */
export async function resolveSafePath(
    root: string,
    target: string,
    access: PathAccess,
): Promise<string> {
    const absolute = resolveInside(root, target);
    const relative = path.relative(root, absolute);
    const firstSegment = relative.split(path.sep)[0] ?? '';

    const denied = DENIED[access].some(name =>
        process.platform === 'win32'
            ? name.toLowerCase() === firstSegment.toLowerCase()
            : name === firstSegment,
    );

    if (denied) {
        throw new ForbiddenError(`Access to '${firstSegment}' is forbidden.`);
    }

    const realRoot = await realpath(root);
    const realTarget = await realpathOfExistingAncestor(absolute);

    if (!isInside(realRoot, realTarget)) {
        throw new ForbiddenError('Path resolves outside workspace via a symbolic link.');
    }

    return absolute;
}

/**
 * realpath ближайшего существующего предка, затем дописывает несуществующий хвост.
 * Нужен для записи новых файлов, у которых ещё нет realpath.
 */
async function realpathOfExistingAncestor(absolute: string): Promise<string> {
    const missing: string[] = [];
    let current = absolute;

    for (;;) {
        try {
            const real = await realpath(current);
            return path.join(real, ...missing.reverse());
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }

            const parent = path.dirname(current);

            if (parent === current) {
                return absolute;
            }

            missing.push(path.basename(current));
            current = parent;
        }
    }
}
