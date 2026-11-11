import languages from '../../resources/languages.json';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from '../types/api';

export interface LanguageRules {
    unsupported: Record<'group' | 'exception' | 'time' | 'multipleActions' | 'unit', string>;
    actionVerbs: string;
    negation: string;
    numeric: string;
    numericPercent: string;
    numericTemperature: string;
    quoted: string;
    valueDomainTemperature: string;
    valueDomainBrightness: string;
    setpointVerb: string;
    setpointTarget: string;
    roomReference: string;
}

export const supportedLanguages = languages as Array<{
    code: Language;
    name: string;
    nlpPackage: string;
    nlpExport: string;
}>;
const ruleCache = new Map<Language, LanguageRules>();
const messageCache = new Map<Language, Record<string, string>>();

export function isSupportedLanguage(value: unknown): value is Language {
    return typeof value === 'string' && supportedLanguages.some(item => item.code === value);
}

export function defaultLanguage(): Language {
    return supportedLanguages[0].code;
}

export function languageRules(language: Language): LanguageRules {
    if (!isSupportedLanguage(language)) {
        throw new Error('Unsupported language');
    }
    let rules = ruleCache.get(language);
    if (!rules) {
        rules = JSON.parse(
            readFileSync(join(__dirname, '../../resources/language-rules', `${language}.json`), 'utf8'),
        ) as LanguageRules;
        ruleCache.set(language, rules);
    }
    return rules;
}

export function languageMessage(language: Language, key: string, fallbackKey?: string): string {
    if (!isSupportedLanguage(language)) {
        throw new Error('Unsupported language');
    }
    let messages = messageCache.get(language);
    if (!messages) {
        messages = JSON.parse(
            readFileSync(join(__dirname, '../../resources/messages', `${language}.json`), 'utf8'),
        ) as Record<string, string>;
        messageCache.set(language, messages);
    }
    return messages[key] ?? (fallbackKey ? messages[fallbackKey] : undefined) ?? key;
}
