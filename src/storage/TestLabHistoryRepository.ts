import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CommandRequest } from '../types/api';
import type { CommandResult } from '../commands/types';

export interface TestLabExchange {
    at: string;
    request: CommandRequest;
    result: CommandResult;
}

export interface TestLabSession {
    id: string;
    startedAt: string;
    updatedAt: string;
    exchanges: TestLabExchange[];
}

export interface TestLabSessionSummary {
    id: string;
    startedAt: string;
    updatedAt: string;
    firstText: string;
    count: number;
}

interface HistoryFile {
    schemaVersion: 1;
    sessions: TestLabSession[];
}

export class TestLabHistoryRepository {
    private queue: Promise<void> = Promise.resolve();

    public constructor(
        private readonly file: string,
        private readonly sessionLimit = 30,
        private readonly exchangeLimit = 50,
    ) {}

    public async list(): Promise<TestLabSessionSummary[]> {
        await this.queue;
        const data = await this.load();
        return data.sessions
            .map(session => ({
                id: session.id,
                startedAt: session.startedAt,
                updatedAt: session.updatedAt,
                firstText: session.exchanges[0]?.request.text ?? '',
                count: session.exchanges.length,
            }))
            .reverse();
    }

    public async get(id: string): Promise<TestLabSession | undefined> {
        await this.queue;
        return (await this.load()).sessions.find(session => session.id === id);
    }

    public append(request: CommandRequest, result: CommandResult): Promise<void> {
        const sessionId = request.sessionId;
        if (!sessionId) {
            return Promise.reject(new Error('Session ID required'));
        }
        return this.mutate(data => {
            const at = new Date().toISOString();
            let session = data.sessions.find(item => item.id === sessionId);
            if (!session) {
                session = { id: sessionId, startedAt: at, updatedAt: at, exchanges: [] };
                data.sessions.push(session);
            }
            session.updatedAt = at;
            session.exchanges.push({ at, request, result });
            session.exchanges = session.exchanges.slice(-this.exchangeLimit);
            data.sessions.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
            data.sessions = data.sessions.slice(-this.sessionLimit);
        });
    }

    public delete(id: string): Promise<void> {
        return this.mutate(data => {
            data.sessions = data.sessions.filter(session => session.id !== id);
        });
    }

    private mutate(change: (data: HistoryFile) => void): Promise<void> {
        const task = this.queue.then(async () => {
            const data = await this.load();
            change(data);
            await mkdir(dirname(this.file), { recursive: true });
            const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
            await writeFile(temp, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' });
            await rename(temp, this.file);
        });
        this.queue = task.catch(() => undefined);
        return task;
    }

    private async load(): Promise<HistoryFile> {
        try {
            const data = JSON.parse(await readFile(this.file, 'utf8')) as HistoryFile;
            if (data.schemaVersion !== 1 || !Array.isArray(data.sessions)) {
                throw new Error('Invalid test lab history');
            }
            return data;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { schemaVersion: 1, sessions: [] };
            }
            throw error;
        }
    }
}
