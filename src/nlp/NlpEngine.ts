import type { Language } from '../types/api';
import type { Analysis, IntentDefinition } from './types';

export interface NlpEngine {
    load(model: Uint8Array | string): Promise<void>;
    train(data: IntentDefinition[], languages: Language[]): Promise<Uint8Array | string>;
    analyze(text: string, language: Language): Promise<Analysis>;
}
