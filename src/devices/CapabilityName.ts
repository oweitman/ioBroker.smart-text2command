import type { Language } from '../types/api';
import type { Capability } from './types';

export function capabilityName(capability: Capability, language: Language): string {
    const configured = capability.name;
    const name =
        typeof configured === 'string'
            ? configured
            : (configured?.[language] ??
              Object.values(configured ?? {}).find(value => typeof value === 'string' && value.trim()));
    return name?.trim() || capability.stateId.split('.').at(-1) || capability.stateId;
}

export function capabilityNameMatches(capability: Capability, text: string, language: Language): boolean {
    const name = capabilityName(capability, language)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase(language)
        .trim();
    if (name.length < 5 && !/\d/.test(name) && capability.kind !== 'button') {
        return false;
    }
    const normalizedText = text
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase(language)
        .replace(/[^\p{L}\p{N}]+/gu, ' ');
    const normalizedName = name.replace(/[^\p{L}\p{N}]+/gu, ' ');
    return ` ${normalizedText} `.includes(` ${normalizedName} `);
}
