import regression from '../../resources/training/regression.json';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from '../types/api';
import { isSupportedLanguage, supportedLanguages } from '../i18n/LanguageConfig';
import type { IntentDefinition, LanguageTrainingData, RegressionCase } from './types';

const VALID_INTENTS = new Set([
    'device.turnOn',
    'device.turnOff',
    'device.setLevel',
    'device.setTemperature',
    'device.getState',
    'device.getValue',
    'None',
]);

export function validateLanguageData(input: unknown, language: Language): LanguageTrainingData {
    if (!input || typeof input !== 'object') {
        throw new Error('Invalid training data');
    }
    const data = input as LanguageTrainingData;
    if (data.schemaVersion !== 1 || data.language !== language || !Array.isArray(data.intents)) {
        throw new Error('Invalid training data');
    }
    const ids = new Set<string>();
    for (const intent of data.intents) {
        if (
            !VALID_INTENTS.has(intent.id) ||
            ids.has(intent.id) ||
            !Array.isArray(intent.utterances) ||
            intent.utterances.length < 2 ||
            intent.utterances.some(text => typeof text !== 'string' || !text.trim() || text.length > 1000)
        ) {
            throw new Error('Invalid training intent');
        }
        ids.add(intent.id);
    }
    if (ids.size !== VALID_INTENTS.size) {
        throw new Error('Incomplete training data');
    }
    return data;
}

export function systemIntents(): IntentDefinition[] {
    const byLanguage = supportedLanguages.map(item =>
        validateLanguageData(
            JSON.parse(
                readFileSync(join(__dirname, '../../resources/training', `${item.code}.json`), 'utf8'),
            ) as unknown,
            item.code,
        ),
    );
    return byLanguage[0].intents.map(entry => ({
        id: entry.id,
        source: 'system',
        enabled: true,
        utterances: Object.fromEntries(
            byLanguage.map(data => [data.language, [...data.intents.find(item => item.id === entry.id)!.utterances]]),
        ),
    }));
}

export function regressionCases(): RegressionCase[] {
    if (regression.schemaVersion !== 1 || !Array.isArray(regression.cases)) {
        throw new Error('Invalid regression data');
    }
    return regression.cases.map(item => {
        if (
            !isSupportedLanguage(item.language) ||
            typeof item.text !== 'string' ||
            (item.intent !== null && !VALID_INTENTS.has(item.intent))
        ) {
            throw new Error('Invalid regression case');
        }
        return { language: item.language, text: item.text, intent: item.intent };
    });
}
