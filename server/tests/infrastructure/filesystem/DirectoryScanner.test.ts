import { LocalFileSystem } from '../../../src/infrastructure/filesystem/LocalFileSystem.js';
import { PathResolver } from '../../../src/infrastructure/filesystem/PathResolver.js';
import { IgnoreService } from '../../../src/infrastructure/filesystem/IgnoreService.js';
import { DirectoryScanner } from '../../../src/infrastructure/filesystem/DirectoryScanner.js';

async function main() {

    const resolver = new PathResolver(process.cwd());

    const ignore = new IgnoreService(process.cwd());

    await ignore.initialize();

    const scanner = new DirectoryScanner(
        new LocalFileSystem(),
        resolver,
        ignore,
    );

    const tree = await scanner.scan();

    console.dir(tree, {
        depth: null,
    });

}

main().catch(console.error);