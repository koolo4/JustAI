import {
    Request,
    Response,
    NextFunction,
} from 'express';

import { WorkspaceService } from './WorkspaceService.js';

import { SaveFileDto } from './dto/SaveFileDto.js';
import { CreateFileDto } from './dto/CreateFileDto.js';
import { CreateFolderDto } from './dto/CreateFolderDto.js';
import { DeletePathDto } from './dto/DeletePathDto.js';
import { RenamePathDto } from './dto/RenamePathDto.js';
import { MovePathDto } from './dto/MovePathDto.js';

import { ValidationError } from '../../core/errors/ValidationError.js';

import { CreateFileValidator } from './validators/CreateFileValidator.js';

export class WorkspaceController {

    constructor(
        private readonly workspaceService: WorkspaceService,
    ) {}

    /**
     * Дерево проекта
     */
    public getTree = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ) => {

        try {

            const tree =
                await this.workspaceService.getTree();

            res.json(tree);

        }
        catch (error) {

            next(error);

        }

    };

    /**
     * Получение файла
     */
    public getFile = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ) => {

        try {

            const path =
                String(
                    req.query.path ?? '',
                );

            const file =
                await this.workspaceService.readFile(
                    path,
                );

            res.json(file);

        }
        catch (error) {

            next(error);

        }

    };

    /**
     * Сохранение файла
     */
    public saveFile = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ) => {

        try {

            const dto =
                req.body as SaveFileDto;

            await this.workspaceService.saveFile(
                dto,
            );

            res.json({

                success: true,

            });

        }
        catch (error) {

            next(error);

        }

    };

    /**
     * Создание файла
     */
    public createFile = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ) => {

        try {

            const validator =
                new CreateFileValidator();

            const result =
                validator.validate(
                    req.body,
                );

            if (!result.success) {

                throw new ValidationError(
                    result.message!,
                );

            }

            await this.workspaceService.createFile(
                result.value!,
            );

            res.status(201).json({

                success: true,

            });

        }
        catch (error) {

            next(error);

        }

    };

    /**
     * Создание папки
     */
    public createFolder = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ) => {

        try {

            const dto =
                req.body as CreateFolderDto;

            await this.workspaceService.createFolder(
                dto,
            );

            res.status(201).json({

                success: true,

            });

        }
        catch (error) {

            next(error);

        }

    };

    /**
     * Удаление файла или папки
     */
    public deletePath = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ) => {

        try {

            const dto =
                req.body as DeletePathDto;

            await this.workspaceService.deletePath(
                dto,
            );

            res.json({

                success: true,

            });

        }
        catch (error) {

            next(error);

        }

    };

    /**
     * Переименование
     */
    public renamePath = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ) => {

        try {

            const dto =
                req.body as RenamePathDto;

            await this.workspaceService.renamePath(
                dto,
            );

            res.json({

                success: true,

            });

        }
        catch (error) {

            next(error);

        }

    };

    /**
     * Перемещение
     */
    public movePath = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ) => {

        try {

            const dto =
                req.body as MovePathDto;

            await this.workspaceService.movePath(
                dto,
            );

            res.json({

                success: true,

            });

        }
        catch (error) {

            next(error);

        }

    };

}