import type { ActionKind } from '../devices/types';
import type { Language } from '../types/api';

export interface IntentDefinition {
    id: string;
    source: 'system' | 'user';
    enabled: boolean;
    utterances: Partial<Record<Language, string[]>>;
    action?:
        | { kind: 'capability'; operation: ActionKind }
        | { kind: 'response'; response: Partial<Record<Language, string>> };
}

export interface LanguageTrainingData {
    schemaVersion: 1;
    language: Language;
    intents: Array<{ id: string; utterances: string[] }>;
}

export interface Analysis {
    intent: string | null;
    confidence: number;
    entities: Array<{ type: string; value: string | number; start?: number; end?: number }>;
    alternatives: Array<{ intent: string; confidence: number }>;
}

export interface RegressionCase {
    language: Language;
    text: string;
    intent: string | null;
}
