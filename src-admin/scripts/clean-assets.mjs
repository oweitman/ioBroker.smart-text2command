import { rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const adminDir = resolve(import.meta.dirname, '../../admin');
const assetsDir = resolve(adminDir, 'assets');
if (relative(adminDir, assetsDir) !== 'assets') throw new Error('Unexpected asset output path');
await rm(assetsDir, { recursive: true, force: true });
