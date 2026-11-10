import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ModelMetadata {
    version: string;
    trainingHash: string;
    engineVersion: string;
    trainedAt: string;
    regressionPassed: number;
    regressionTotal: number;
}

interface ModelEntry extends ModelMetadata {
    checksum: string;
}

interface Manifest {
    schemaVersion: 1;
    active: ModelEntry;
    previous?: ModelEntry;
}

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export class ModelRepository {
    public constructor(private readonly directory: string) {}

    public async loadActive(): Promise<{ model: string; metadata: ModelMetadata } | undefined> {
        const manifest = await this.readManifest();
        if (!manifest) {
            return undefined;
        }
        try {
            return await this.readEntry(manifest.active);
        } catch (error) {
            if (!manifest.previous) {
                throw error;
            }
            return this.readEntry(manifest.previous);
        }
    }

    public async activate(model: string, metadata: ModelMetadata): Promise<void> {
        if (!metadata.version || !/^[a-f0-9]{16,64}$/.test(metadata.version)) {
            throw new Error('Invalid model version');
        }
        await mkdir(this.directory, { recursive: true });
        const old = await this.readManifest();
        const entry: ModelEntry = { ...metadata, checksum: digest(model) };
        const target = this.modelPath(entry.version);
        await this.atomicWrite(target, model);
        const manifest: Manifest = {
            schemaVersion: 1,
            active: entry,
            previous: old?.active.version === entry.version ? old.previous : old?.active,
        };
        await this.atomicWrite(this.manifestPath(), JSON.stringify(manifest));
    }

    public async rollback(): Promise<void> {
        const manifest = await this.readManifest();
        if (!manifest?.previous) {
            throw new Error('No previous model');
        }
        await this.readEntry(manifest.previous);
        const previous: Manifest = {
            schemaVersion: 1,
            active: manifest.previous,
            previous: manifest.active,
        };
        await this.atomicWrite(this.manifestPath(), JSON.stringify(previous));
    }

    private async readEntry(entry: ModelEntry): Promise<{ model: string; metadata: ModelMetadata }> {
        const model = await readFile(this.modelPath(entry.version), 'utf8');
        if (digest(model) !== entry.checksum) {
            throw new Error('Model checksum mismatch');
        }
        const { checksum: _checksum, ...metadata } = entry;
        return { model, metadata };
    }

    private async readManifest(): Promise<Manifest | undefined> {
        let raw: string;
        try {
            raw = await readFile(this.manifestPath(), 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
        const manifest = JSON.parse(raw) as Manifest;
        if (manifest.schemaVersion !== 1 || !manifest.active?.version || !manifest.active?.checksum) {
            throw new Error('Invalid model manifest');
        }
        return manifest;
    }

    private modelPath(version: string): string {
        if (!/^[a-f0-9]{16,64}$/.test(version)) {
            throw new Error('Invalid model version');
        }
        return join(this.directory, `model-${version}.json`);
    }

    private manifestPath(): string {
        return join(this.directory, 'active-v1.json');
    }

    private async atomicWrite(target: string, content: string): Promise<void> {
        const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
        await rename(temp, target);
    }
}
