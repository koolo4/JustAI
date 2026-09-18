import { LocalFileSystem } from './LocalFileSystem.js';
import { PathResolver } from './PathResolver.js';
import { IgnoreService } from './IgnoreService.js';



export interface WorkspaceNode {

    name: string;

    path: string;

    type: 'file' | 'folder';

    children?: WorkspaceNode[];

}



export class DirectoryScanner {


    constructor(

        private readonly fileSystem: LocalFileSystem,

        private readonly pathResolver: PathResolver,

        private readonly ignoreService: IgnoreService,

    ) {}



    /**
     * Сканирование workspace
     */
    public async scan(): Promise<WorkspaceNode[]> {


        return this.scanDirectory(
            this.pathResolver.resolve(''),
            '',
        );


    }




    private async scanDirectory(

        absolutePath: string,

        relativePath: string,

    ): Promise<WorkspaceNode[]> {


        const entries =
            await this.fileSystem.readDirectory(
                absolutePath,
            );



        const nodes:
            WorkspaceNode[] = [];



        for (
            const entry
            of entries
        ) {


            const entryRelativePath =
                relativePath
                    ? `${relativePath}/${entry.name}`
                    : entry.name;



            /**
             * IgnoreService работает по имени
             */
            if (
                this.ignoreService.shouldIgnore(
                    entry.name,
                )
            ) {

                continue;

            }



            const entryAbsolutePath =
                `${absolutePath}/${entry.name}`;



            if (
                entry.isDirectory()
            ) {


                const children =
                    await this.scanDirectory(
                        entryAbsolutePath,
                        entryRelativePath,
                    );



                nodes.push({

                    name:
                        entry.name,

                    path:
                        entryRelativePath,

                    type:
                        'folder',

                    children,

                });


                continue;

            }



            nodes.push({

                name:
                    entry.name,

                path:
                    entryRelativePath,

                type:
                    'file',

            });


        }



        return nodes;


    }


}