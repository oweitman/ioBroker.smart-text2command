import { randomUUID } from 'node:crypto';
import type { ActionKind } from '../devices/types';
import type { CommandRequest, Language } from '../types/api';

export interface PendingClarification {
    id: string;
    key: 'room' | 'device' | 'capability' | 'value' | 'parameter';
    clientKey: string;
    sessionId?: string;
    request: CommandRequest;
    language: Language;
    action: ActionKind | 'sendTo';
    intent: string;
    confidence: number;
    deviceIds: string[];
    roomIds?: string[];
    stateIds?: string[];
    selectedRoomId?: string;
    selectedDeviceId?: string;
    question?: string;
    parameterName?: string;
    parameterValues?: Record<string, string | number>;
    options?: Array<{ id: string; label: string }>;
    expiresAt: number;
}

export class SessionStore {
    private sessions = new Map<string, PendingClarification>();

    public constructor(
        private readonly ttlMs = 5 * 60_000,
        private readonly maxSessions = 100,
        private readonly now: () => number = Date.now,
    ) {}

    public create(input: Omit<PendingClarification, 'id' | 'expiresAt'>): PendingClarification {
        this.expire();
        this.clear(input.clientKey, input.sessionId);
        if (this.sessions.size >= this.maxSessions) {
            this.sessions.delete(this.sessions.keys().next().value!);
        }
        const session = { ...input, id: randomUUID(), expiresAt: this.now() + this.ttlMs };
        this.sessions.set(session.id, session);
        return session;
    }

    public get(id: string, clientKey: string, sessionId?: string): PendingClarification | undefined {
        this.expire();
        const session = this.sessions.get(id);
        if (!session || session.clientKey !== clientKey || session.sessionId !== sessionId) {
            return undefined;
        }
        return session;
    }

    public consume(id: string, clientKey: string, sessionId?: string): PendingClarification | undefined {
        const session = this.get(id, clientKey, sessionId);
        if (!session) {
            return undefined;
        }
        this.sessions.delete(id);
        return session;
    }

    public clear(clientKey: string, sessionId?: string): void {
        for (const [id, session] of this.sessions) {
            if (session.clientKey === clientKey && session.sessionId === sessionId) {
                this.sessions.delete(id);
            }
        }
    }

    private expire(): void {
        const now = this.now();
        for (const [id, session] of this.sessions) {
            if (session.expiresAt <= now) {
                this.sessions.delete(id);
            }
        }
    }
}
