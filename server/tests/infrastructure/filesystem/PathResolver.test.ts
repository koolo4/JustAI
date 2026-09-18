import { PathResolver } from '../../../src/infrastructure/filesystem/PathResolver.js';

const resolver = new PathResolver(process.cwd());

console.log('Workspace:', resolver.getRoot());

console.log(resolver.resolve('package.json'));

console.log(
    resolver.relative(
        resolver.resolve('package.json')
    )
);

try {
    console.log(
        resolver.resolve('../../../Windows')
    );
} catch {
    console.log('✔ Защита работает');
}