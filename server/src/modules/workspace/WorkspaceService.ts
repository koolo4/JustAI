import { DirectoryScanner } from '../../infrastructure/filesystem/DirectoryScanner.js';
import { LocalFileSystem } from '../../infrastructure/filesystem/LocalFileSystem.js';
import { PathResolver } from '../../infrastructure/filesystem/PathResolver.js';

import { NotFoundError } from '../../core/errors/NotFoundError.js';

import { SaveFileDto } from './dto/SaveFileDto.js';
import { CreateFileDto } from './dto/CreateFileDto.js';
import { CreateFolderDto } from './dto/CreateFolderDto.js';
import { DeletePathDto } from './dto/DeletePathDto.js';
import { RenamePathDto } from './dto/RenamePathDto.js';
import { MovePathDto } from './dto/MovePathDto.js';

import {
    EventBus,
    FileCreatedEvent,
    FileSavedEvent,
    FileDeletedEvent,
    FileMovedEvent,
    FileRenamedEvent,
} from '../../core/events/index.js';

export class WorkspaceService {

    constructor(
        private readonly fileSystem: LocalFileSystem,
        private readonly pathResolver: PathResolver,
        private readonly directoryScanner: DirectoryScanner,
        private readonly eventBus: EventBus,
    ) {}

    /**
     * Возвращает дерево проекта
     */
    public async getTree() {

        return this.directoryScanner.scan();

    }

    /**
     * Чтение файла
     */
    public async readFile(
        relativePath: string,
    ) {

        const absolutePath =
            this.pathResolver.resolve(
                relativePath,
            );

        const exists =
            await this.fileSystem.exists(
                absolutePath,
            );

        if (!exists) {

            throw new NotFoundError(
                'File not found.',
            );

        }

        const content =
            await this.fileSystem.readFile(
                absolutePath,
            );

        return {

            path: relativePath,

            content,

        };

    }

    /**
     * Сохранение файла
     */
    public async saveFile(
        dto: SaveFileDto,
    ): Promise<void> {

        const absolutePath =
            this.pathResolver.resolve(
                dto.path,
            );

        const exists =
            await this.fileSystem.exists(
                absolutePath,
            );

        if (!exists) {

            throw new NotFoundError(
                'File not found.',
            );

        }

        await this.fileSystem.writeFile(
            absolutePath,
            dto.content,
        );

        await this.eventBus.publish(
            new FileSavedEvent(
                dto.path,
            ),
        );

    }

    /**
     * Создание файла
     */
    public async createFile(
        dto: CreateFileDto,
    ): Promise<void> {

        const absolutePath =
            this.pathResolver.resolve(
                dto.path,
            );

        await this.fileSystem.writeFile(
            absolutePath,
            dto.content ?? '',
        );

        await this.eventBus.publish(
            new FileCreatedEvent(
                dto.path,
            ),
        );

    }

    /**
     * Создание папки
     */
    public async createFolder(
        dto: CreateFolderDto,
    ): Promise<void> {

        const absolutePath =
            this.pathResolver.resolve(
                dto.path,
            );

        await this.fileSystem.mkdir(
            absolutePath,
        );

    }

    /**
     * Удаление файла или папки
     */
    public async deletePath(
        dto: DeletePathDto,
    ): Promise<void> {

        const absolutePath =
            this.pathResolver.resolve(
                dto.path,
            );

        const exists =
            await this.fileSystem.exists(
                absolutePath,
            );

        if (!exists) {

            throw new NotFoundError(
                'Path not found.',
            );

        }

        await this.fileSystem.delete(
            absolutePath,
        );

        await this.eventBus.publish(
            new FileDeletedEvent(
                dto.path,
            ),
        );

    }

    /**
     * Переименование
     */
    public async renamePath(
        dto: RenamePathDto,
    ): Promise<void> {

        const oldPath =
            this.pathResolver.resolve(
                dto.oldPath,
            );

        const newPath =
            this.pathResolver.resolve(
                dto.newPath,
            );

        const exists =
            await this.fileSystem.exists(
                oldPath,
            );

        if (!exists) {

            throw new NotFoundError(
                'Path not found.',
            );

        }

        await this.fileSystem.rename(
            oldPath,
            newPath,
        );

        await this.eventBus.publish(
            new FileRenamedEvent(
                dto.oldPath,
                dto.newPath,
            ),
        );

    }

    /**
     * Перемещение файла или папки
     */
    public async movePath(
        dto: MovePathDto,
    ): Promise<void> {

        const sourcePath =
            this.pathResolver.resolve(
                dto.source,
            );

        const destinationPath =
            this.pathResolver.resolve(
                dto.destination,
            );

        const exists =
            await this.fileSystem.exists(
                sourcePath,
            );

        if (!exists) {

            throw new NotFoundError(
                'Path not found.',
            );

        }

        await this.fileSystem.move(
            sourcePath,
            destinationPath,
        );

        await this.eventBus.publish(
            new FileMovedEvent(
                dto.source,
                dto.destination,
            ),
        );

    }

}