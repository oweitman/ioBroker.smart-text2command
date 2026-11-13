import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IntentDefinition } from './types';
import { validateSendToAction } from './SendToAction';
import { supportedLanguages } from '../i18n/LanguageConfig';

interface IntentStore {
    schemaVersion: 1;
    intents: IntentDefinition[];
}

interface Envelope {
    schemaVersion: 1;
    checksum: string;
    data: IntentStore;
}

const OPERATIONS = new Set(['turnOn', 'turnOff', 'setValue', 'press', 'getState', 'getValue']);

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function validate(intents: IntentDefinition[]): void {
    if (!Array.isArray(intents) || intents.length > 100) {
        throw new Error('Invalid user intents');
    }
    const ids = new Set<string>();
    for (const intent of intents) {
        if (
            intent.source !== 'user' ||
            typeof intent.id !== 'string' ||
            !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(intent.id) ||
            intent.id.startsWith('device.') ||
            intent.id === 'None' ||
            ids.has(intent.id) ||
            typeof intent.enabled !== 'boolean'
        ) {
            throw new Error('Invalid user intent');
        }
        ids.add(intent.id);
        for (const { code: language } of supportedLanguages) {
            const examples = intent.utterances?.[language] ?? [];
            if (
                !Array.isArray(examples) ||
                examples.some(text => typeof text !== 'string' || !text.trim() || text.length > 1000)
            ) {
                throw new Error('Invalid utterances');
            }
        }
        if (
            !intent.action ||
            (intent.action.kind !== 'capability' &&
                intent.action.kind !== 'response' &&
                intent.action.kind !== 'sendTo') ||
            (intent.action.kind === 'capability' && !OPERATIONS.has(intent.action.operation)) ||
            (intent.action.kind === 'response' &&
                !Object.values(intent.action.response).some(text => typeof text === 'string' && !!text.trim()))
        ) {
            throw new Error('Invalid intent action');
        }
        if (intent.action.kind === 'sendTo') {
            validateSendToAction(intent.action);
        }
    }
}

export class IntentRepository {
    public constructor(private readonly file: string) {}

    public async load(): Promise<IntentDefinition[]> {
        let raw: string;
        try {
            raw = await readFile(this.file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return [];
            }
            throw error;
        }
        const envelope = JSON.parse(raw) as Envelope;
        if (
            envelope.schemaVersion !== 1 ||
            envelope.data?.schemaVersion !== 1 ||
            envelope.checksum !== digest(JSON.stringify(envelope.data))
        ) {
            throw new Error('Invalid intent store');
        }
        validate(envelope.data.intents);
        return envelope.data.intents;
    }

    public async save(intents: IntentDefinition[]): Promise<void> {
        validate(intents);
        const data: IntentStore = { schemaVersion: 1, intents };
        await mkdir(dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        const envelope: Envelope = { schemaVersion: 1, checksum: digest(JSON.stringify(data)), data };
        await writeFile(temp, JSON.stringify(envelope), { encoding: 'utf8', flag: 'wx' });
        await rename(temp, this.file);
    }
}
