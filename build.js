import { cp, mkdir, rm } from 'node:fs/promises';
const files = ['index.html', 'styles.css', 'app.js', 'engine.js', 'router.js'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
await Promise.all(files.map(file => cp(file, `dist/${file}`)));
console.log(`Built ${files.length} files to dist/`);
