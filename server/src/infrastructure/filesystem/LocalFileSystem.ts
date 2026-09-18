import fs from 'node:fs/promises';



export class LocalFileSystem {


    private readonly fs = fs;



    /**
     * Проверка существования
     */
    public async exists(
        path: string,
    ): Promise<boolean> {

        try {

            await this.fs.access(
                path,
            );

            return true;

        }
        catch {

            return false;

        }

    }



    /**
     * Чтение файла
     */
    public async readFile(
        path: string,
    ): Promise<string> {

        return this.fs.readFile(
            path,
            'utf-8',
        );

    }



    /**
     * Запись файла
     */
    public async writeFile(
        path: string,
        content: string,
    ): Promise<void> {

        await this.fs.writeFile(
            path,
            content,
            'utf-8',
        );

    }



    /**
     * Создание папки
     */
    public async mkdir(
        path: string,
    ): Promise<void> {

        await this.fs.mkdir(
            path,
            {
                recursive:true,
            },
        );

    }



    /**
     * Удаление файла или папки
     */
    public async delete(
        path:string,
    ): Promise<void> {


        await this.fs.rm(
            path,
            {
                recursive:true,
                force:true,
            },
        );


    }



    /**
     * Переименование
     */
    public async rename(
        oldPath:string,
        newPath:string,
    ): Promise<void> {


        await this.fs.rename(
            oldPath,
            newPath,
        );


    }



    /**
     * Перемещение
     */
    public async move(
        source:string,
        destination:string,
    ): Promise<void> {


        await this.fs.rename(
            source,
            destination,
        );


    }



    /**
     * Получение содержимого директории
     */
    public async readDirectory(
        path:string,
    ) {


        return this.fs.readdir(
            path,
            {
                withFileTypes:true,
            },
        );


    }



    /**
     * Получение информации о файле
     */
    public async stat(
        path:string,
    ) {


        return this.fs.stat(
            path,
        );


    }


}