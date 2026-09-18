import { LocalFileSystem } from '../../../src/infrastructure/filesystem/LocalFileSystem.js';

async function main() {
    const fs = new LocalFileSystem();

    const dir = './temp';
    const file = './temp/test.txt';

    await fs.createDirectory(dir);
    await fs.writeFile(file, 'Hello JustAI');

    console.log(await fs.exists(file));
    console.log(await fs.readFile(file));

    console.log(await fs.readDirectory(dir));

    await fs.delete(dir);

    console.log('✔ LocalFileSystem OK');
}

main().catch(console.error);