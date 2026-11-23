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
    status: 'success' | 'clarification' | 'cancelled' | 'rejected' | 'error';
    intent?: string;
    confidence?: number;
    language: Language;
    response: string;
    errorCode?: string;
    candidates?: Array<{ deviceId: string; score: number; reasons: string[] }>;
    actions?: ActionResult[];
    clarification?: {
        id: string;
        key:
            | 'action'
            | 'room'
            | 'device'
            | 'relativeDevice'
            | 'relativeCapability'
            | 'colorDevice'
            | 'colorName'
            | 'mediaDevice'
            | 'capability'
            | 'value'
            | 'parameter';
        parameter?: string;
        options?: Array<{ id: string; label: string }>;
    };
    modelVersion?: string;
    durationMs?: number;
    historyError?: string;
    analysis?: {
        alternatives?: Array<{ intent: string; confidence: number }>;
        entities?: Array<{ type: string; value: string | number; start: number; end: number }>;
        candidates?: Array<{ deviceId: string; score: number; reasons: string[] }>;
        devices?: Array<{
            deviceId: string;
            deviceName: string;
            nameMatched: boolean;
            fuzzyNameMatched?: boolean;
            roomMatched?: boolean;
        }>;
        functions?: Array<{
            deviceId: string;
            deviceName: string;
            functionId: string;
            name: string;
            mentioned: boolean;
            roomMatched?: boolean;
        }>;
        dataPoints?: Array<{
            deviceId: string;
            deviceName: string;
            stateId: string;
            name: string;
            role?: string;
            kind: string;
            readable: boolean;
            writable: boolean;
            actionAllowed: boolean;
            domainMatched: boolean;
            nameMatched: boolean;
            roomMatched?: boolean;
        }>;
        policyDecision?: string;
        relative?: {
            operation: 'set' | 'adjust' | 'step';
            property: string;
            intensity: string;
            previousValue?: number | string;
            targetValue: number | string;
            appliedDelta?: number;
            unit: string;
            source: 'builtIn' | 'global' | 'device';
        };
        currentState?: {
            stateId: string;
            value?: boolean | number | string | null;
            valueType: string;
            quality?: number;
            issue?: 'missing' | 'quality' | 'type' | 'range';
        };
        plan?: { action: ActionKind; operation: 'read' | 'write'; stateId: string; value?: boolean | number | string };
        sendTo?: {
            instance: string;
            command: string;
            parameters: Record<string, string | number>;
            missing: string[];
            rawCallback?: unknown;
            message?: unknown;
            transportError?: string;
        };
    };
}

export interface DeviceIO {
    getObject(id: string): Promise<ObjectSnapshot | undefined>;
    getState(id: string): Promise<{ val: unknown; q?: number } | undefined>;
    setState(id: string, value: boolean | number | string): Promise<void>;
}
