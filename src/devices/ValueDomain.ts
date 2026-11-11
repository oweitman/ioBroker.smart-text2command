import type { Language } from '../types/api';
import type { Capability } from './types';
import { languageRules } from '../i18n/LanguageConfig';

export type ValueDomain = 'temperature' | 'brightness';

export function inferValueDomain(text: string, language: Language): ValueDomain | undefined {
    const rules = languageRules(language);
    const normalized = text
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase(language)
        .replace(/[^\p{L}\p{N}]+/gu, ' ');
    const temperature = new RegExp(rules.valueDomainTemperature, 'u').test(normalized);
    const brightness = new RegExp(rules.valueDomainBrightness, 'u').test(normalized);
    if (temperature === brightness) {
        return undefined;
    }
    return temperature ? 'temperature' : 'brightness';
}

export function matchesValueDomain(capability: Capability, domain: ValueDomain | undefined): boolean {
    if (!domain) {
        return true;
    }
    return domain === 'temperature'
        ? capability.kind === 'readTemperature' || capability.kind === 'temperatureSetpoint'
        : capability.kind === 'brightness';
}
