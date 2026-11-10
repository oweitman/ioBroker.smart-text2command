import type { Language } from '../types/api';
import type { Capability } from './types';

export type ValueDomain = 'temperature' | 'brightness';

export function inferValueDomain(text: string, language: Language): ValueDomain | undefined {
    const normalized = text
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase(language)
        .replace(/[^\p{L}\p{N}]+/gu, ' ');
    const temperature =
        language === 'de'
            ? /\b(warm|warme|warmer|temperatur|grad|kalt|heiss)\b/.test(normalized)
            : /\b(warm|temperature|degrees?|cold|hot)\b/.test(normalized);
    const brightness =
        language === 'de'
            ? /\b(hell|helligkeit|dimmwert)\b/.test(normalized)
            : /\b(bright|brightness|dimming)\b/.test(normalized);
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
