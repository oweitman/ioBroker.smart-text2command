import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) {
    throw new Error('Run this script through npm so npm_execpath is available');
}

function npm(args, stdio) {
    const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: projectDir, stdio });
    if (result.error) {
        throw result.error;
    }
    return result.status;
}

if (npm(['ls', '--prefix', 'src-admin', '--depth=0'], 'ignore') !== 0) {
    console.log('Installing Admin dependencies from src-admin/package-lock.json');
    const status = npm(['ci', '--prefix', 'src-admin'], 'inherit');
    if (status !== 0) {
        process.exit(status ?? 1);
    }
}
