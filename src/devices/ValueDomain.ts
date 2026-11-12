import type { Language } from '../types/api';
import type { Capability } from './types';
import { capabilityName } from './CapabilityName';
import { languageRules } from '../i18n/LanguageConfig';

export type ValueDomain = 'temperature' | 'brightness' | 'position' | 'tilt';

export function inferValueDomain(text: string, language: Language): ValueDomain | undefined {
    const rules = languageRules(language);
    const normalized = text
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase(language)
        .replace(/[^\p{L}\p{N}]+/gu, ' ');
    const temperature = new RegExp(rules.valueDomainTemperature, 'u').test(normalized);
    const brightness = new RegExp(rules.valueDomainBrightness, 'u').test(normalized);
    const tilt = new RegExp(rules.valueDomainTilt, 'u').test(normalized);
    const position = new RegExp(rules.valueDomainPosition, 'u').test(normalized);
    if (tilt) {
        return 'tilt';
    }
    if (position && !temperature && !brightness) {
        return 'position';
    }
    if (temperature === brightness) {
        return undefined;
    }
    return temperature ? 'temperature' : 'brightness';
}

export function matchesValueDomain(
    capability: Capability,
    domain: ValueDomain | undefined,
    language: Language,
): boolean {
    if (!domain) {
        return true;
    }
    const namedDomain = inferValueDomain(capabilityName(capability, language), language);
    if (namedDomain) {
        return namedDomain === domain;
    }
    if (capability.role === 'value' || capability.role === 'level') {
        return inferValueDomain(capability.stateId.split('.').at(-1) ?? '', language) === domain;
    }
    if (domain === 'temperature') {
        return capability.role?.endsWith('.temperature') === true;
    }
    if (domain === 'brightness') {
        return capability.role?.endsWith('.brightness') === true || capability.role?.endsWith('.dimmer') === true;
    }
    return domain === 'tilt'
        ? capability.role?.endsWith('.tilt') === true
        : capability.role?.endsWith('.blind') === true;
}
