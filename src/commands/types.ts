import type { ActionKind, Capability, ObjectSnapshot } from '../devices/types';
import type { Language } from '../types/api';

export interface PlannedAction {
    deviceId: string;
    action: ActionKind;
    capability: Capability;
    operation: 'read' | 'write';
    stateId: string;
    value?: boolean | number | string;
}

export interface ActionResult {
    deviceId: string;
    stateId: string;
    status: 'planned' | 'accepted' | 'confirmed' | 'rejected' | 'failed';
    value?: boolean | number | string | null;
    message?: string;
}

export interface CommandResult {
    requestId: string;
    status: 'success' | 'clarification' | 'rejected' | 'error';
    intent?: string;
    confidence?: number;
    language: Language;
    response: string;
    errorCode?: string;
    candidates?: Array<{ deviceId: string; score: number; reasons: string[] }>;
    actions?: ActionResult[];
    clarification?: { id: string; key: 'device' | 'value'; options?: Array<{ id: string; label: string }> };
    modelVersion?: string;
    durationMs?: number;
    analysis?: {
        alternatives?: Array<{ intent: string; confidence: number }>;
        entities?: Array<{ type: string; value: string | number; start: number; end: number }>;
        candidates?: Array<{ deviceId: string; score: number; reasons: string[] }>;
        policyDecision?: string;
        plan?: { action: ActionKind; operation: 'read' | 'write'; stateId: string; value?: boolean | number | string };
    };
}

export interface DeviceIO {
    getObject(id: string): Promise<ObjectSnapshot | undefined>;
    getState(id: string): Promise<{ val: unknown } | undefined>;
    setState(id: string, value: boolean | number | string): Promise<void>;
}
