import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DeviceStore } from '../devices/types';

interface Envelope {
    schemaVersion: 1;
    checksum: string;
    data: DeviceStore;
}

function checksum(data: DeviceStore): string {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export class DeviceRepository {
    public constructor(private readonly file: string) {}
    public async load(): Promise<DeviceStore | undefined> {
        let raw: string;
        try {
            raw = await readFile(this.file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
        const envelope = JSON.parse(raw) as Envelope;
        if (
            envelope.schemaVersion !== 1 ||
            envelope.data?.schemaVersion !== 1 ||
            !Array.isArray(envelope.data.devices) ||
            envelope.checksum !== checksum(envelope.data)
        ) {
            throw new Error('Invalid device store');
        }
        return envelope.data;
    }
    public async save(data: DeviceStore): Promise<void> {
        if (data.schemaVersion !== 1) {
            throw new Error('Unsupported device store schema');
        }
        await mkdir(dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        const envelope: Envelope = { schemaVersion: 1, checksum: checksum(data), data };
        await writeFile(temp, JSON.stringify(envelope), { encoding: 'utf8', flag: 'wx' });
        await rename(temp, this.file);
    }
}
