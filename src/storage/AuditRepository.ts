import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEntry {
    at: string;
    requestId: string;
    intent?: string;
    deviceId?: string;
    decision: string;
    result: string;
    errorCode?: string;
}

export class AuditRepository {
    private queue: Promise<void> = Promise.resolve();

    public constructor(
        private readonly file: string,
        private readonly limit = 500,
    ) {}

    public append(entry: AuditEntry): Promise<void> {
        const task = this.queue.then(async () => {
            let entries: AuditEntry[] = [];
            try {
                entries = JSON.parse(await readFile(this.file, 'utf8')) as AuditEntry[];
                if (!Array.isArray(entries)) {
                    throw new Error('Invalid audit data');
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
            entries.push(entry);
            await mkdir(dirname(this.file), { recursive: true });
            const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
            await writeFile(temp, JSON.stringify(entries.slice(-this.limit)), { encoding: 'utf8', flag: 'wx' });
            await rename(temp, this.file);
        });
        this.queue = task.catch(() => undefined);
        return task;
    }
}
