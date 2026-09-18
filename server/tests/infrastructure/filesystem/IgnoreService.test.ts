import { IgnoreService } from '../../../src/infrastructure/filesystem/IgnoreService.js';

async function main() {

    const ignore = new IgnoreService(process.cwd());

    await ignore.initialize();

    console.log(ignore.getRules());

    console.log(ignore.shouldIgnore('.git'));

    console.log(ignore.shouldIgnore('node_modules'));

    console.log(ignore.shouldIgnore('src'));

}

main().catch(console.error);