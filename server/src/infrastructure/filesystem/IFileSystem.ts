export interface FileInfo {
    path: string;
    name: string;
    isDirectory: boolean;
    size: number;
    modifiedAt: Date;
}

export interface IFileSystem {
    exists(path: string): Promise<boolean>;

    readFile(path: string): Promise<string>;

    writeFile(path: string, content: string): Promise<void>;

    createDirectory(path: string): Promise<void>;

    delete(path: string): Promise<void>;

    rename(oldPath: string, newPath: string): Promise<void>;

    readDirectory(path: string): Promise<FileInfo[]>;

    mkdir(path: string): Promise<void>;

    remove(path: string): Promise<void>;

    rename(
        oldPath: string,
        newPath: string,
    ): Promise<void>;

    move(
        source: string,
        destination: string,
    ): Promise<void>;
}