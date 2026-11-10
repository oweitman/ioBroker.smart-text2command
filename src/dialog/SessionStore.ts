import { randomUUID } from 'node:crypto';
import type { ActionKind } from '../devices/types';
import type { CommandRequest, Language } from '../types/api';

export interface PendingClarification {
    id: string;
    key: 'device' | 'value';
    clientKey: string;
    sessionId?: string;
    request: CommandRequest;
    language: Language;
    action: ActionKind;
    intent: string;
    confidence: number;
    deviceIds: string[];
    selectedDeviceId?: string;
    expiresAt: number;
}

export class SessionStore {
    private sessions = new Map<string, PendingClarification>();

    public constructor(
        private readonly ttlMs = 5 * 60_000,
        private readonly maxSessions = 100,
    ) {}

    public create(input: Omit<PendingClarification, 'id' | 'expiresAt'>): PendingClarification {
        this.expire();
        if (this.sessions.size >= this.maxSessions) {
            this.sessions.delete(this.sessions.keys().next().value!);
        }
        const session = { ...input, id: randomUUID(), expiresAt: Date.now() + this.ttlMs };
        this.sessions.set(session.id, session);
        return session;
    }

    public consume(id: string, clientKey: string, sessionId?: string): PendingClarification | undefined {
        this.expire();
        const session = this.sessions.get(id);
        if (!session || session.clientKey !== clientKey || session.sessionId !== sessionId) {
            return undefined;
        }
        this.sessions.delete(id);
        return session;
    }

    private expire(): void {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (session.expiresAt <= now) {
                this.sessions.delete(id);
            }
        }
    }
}
