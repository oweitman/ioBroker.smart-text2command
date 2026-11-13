import type { Language } from '../types/api';
import languages from '../../resources/languages.json';
import type { SendToIntentAction } from './types';

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const supportedLanguages = languages;
const TARGET = /^[A-Za-z][A-Za-z0-9_-]*\.[0-9]+$/;
const COMMAND = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function validateSendToAction(action: SendToIntentAction): void {
    if (!TARGET.test(action.instance)) {
        throw new Error('Invalid sendTo instance');
    }
    if (!COMMAND.test(action.command)) {
        throw new Error('Invalid sendTo command');
    }
    if (!Array.isArray(action.parameters) || action.parameters.length > 20) {
        throw new Error('Invalid parameters');
    }
    const names = new Set<string>();
    for (const parameter of action.parameters) {
        if (!NAME.test(parameter.name) || names.has(parameter.name)) {
            throw new Error('Invalid or duplicate parameter name');
        }
        if (parameter.type !== 'string' && parameter.type !== 'number') {
            throw new Error('Invalid parameter type');
        }
        names.add(parameter.name);
        for (const { code } of supportedLanguages) {
            if (typeof parameter.prompt?.[code] !== 'string' || !parameter.prompt[code]?.trim()) {
                throw new Error(`Missing ${code} prompt for ${parameter.name}`);
            }
        }
    }
    const used = new Set<string>();
    const visit = (value: unknown, depth: number): void => {
        if (depth > 20) {
            throw new Error('Payload template is too deep');
        }
        if (Array.isArray(value)) {
            return value.forEach(item => visit(item, depth + 1));
        }
        if (value && typeof value === 'object') {
            const object = value as Record<string, unknown>;
            if ('$param' in object) {
                if (
                    Object.keys(object).length !== 1 ||
                    typeof object.$param !== 'string' ||
                    !names.has(object.$param)
                ) {
                    throw new Error('Invalid payload placeholder');
                }
                used.add(object.$param);
            } else {
                Object.values(object).forEach(item => visit(item, depth + 1));
            }
        }
    };
    if (
        !action.payloadTemplate ||
        typeof action.payloadTemplate !== 'object' ||
        Array.isArray(action.payloadTemplate)
    ) {
        throw new Error('Payload template must be a JSON object');
    }
    if (JSON.stringify(action.payloadTemplate).length > 16_384) {
        throw new Error('Payload template is too large');
    }
    visit(action.payloadTemplate, 0);
    if (used.size !== names.size) {
        throw new Error('Every parameter must occur in the payload');
    }
    if (!names.size) {
        return;
    }
    for (const { code } of supportedLanguages) {
        const patterns = action.extractionPatterns?.[code];
        if (!Array.isArray(patterns) || !patterns.length || patterns.length > 30) {
            throw new Error(`Missing ${code} extraction pattern`);
        }
        for (const pattern of patterns) {
            if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 1000) {
                throw new Error('Invalid pattern');
            }
            const slots = [...pattern.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
            if (
                slots.some(slot => !names.has(slot)) ||
                new Set(slots).size !== slots.length ||
                /[{}]/.test(pattern.replace(/\{[^{}]+\}/g, ''))
            ) {
                throw new Error('Invalid pattern placeholder');
            }
        }
    }
}

export function parseParameter(
    value: string,
    type: 'string' | 'number',
    language: Language,
): string | number | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (type === 'string') {
        return trimmed;
    }
    const decimal = new Intl.NumberFormat(language).format(1.5).replace(/[\d\s]/g, '');
    const normalized = decimal === ',' ? trimmed.replace(',', '.') : trimmed;
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
        return undefined;
    }
    const number = Number(normalized);
    return Number.isFinite(number) ? number : undefined;
}

export function extractParameters(
    action: SendToIntentAction,
    text: string,
    language: Language,
): Record<string, string | number> {
    const results: Array<Record<string, string | number>> = [];
    for (const pattern of action.extractionPatterns?.[language] ?? []) {
        const { slots, regex } = compilePattern(pattern);
        const matched = regex.exec(text);
        if (!matched) {
            continue;
        }
        const values: Record<string, string | number> = {};
        for (let index = 0; index < slots.length; index++) {
            const parameter = action.parameters.find(item => item.name === slots[index])!;
            const value = parseParameter(matched[index + 1], parameter.type, language);
            if (value !== undefined) {
                values[parameter.name] = value;
            }
        }
        results.push(values);
    }
    if (!results.length) {
        return {};
    }
    const first = results[0];
    const conflicted = new Set<string>();
    for (const result of results.slice(1)) {
        for (const [key, value] of Object.entries(result)) {
            if (conflicted.has(key)) {
                continue;
            }
            if (first[key] !== undefined && first[key] !== value) {
                delete first[key];
                conflicted.add(key);
            } else if (first[key] === undefined) {
                first[key] = value;
            }
        }
    }
    return first;
}

function compilePattern(pattern: string): { slots: string[]; regex: RegExp } {
    const slots: string[] = [];
    const parts = pattern.split(/(\{[A-Za-z][A-Za-z0-9_]*\})/g).filter(Boolean);
    const expression = parts
        .map(part => {
            if (part.startsWith('{') && part.endsWith('}')) {
                slots.push(part.slice(1, -1));
                return '(.+?)';
            }
            return escape(part).replace(/\s+/g, '\\s+');
        })
        .join('');
    return { slots, regex: new RegExp(`^\\s*${expression}\\s*$`, 'iu') };
}

export function matchesSendToPattern(action: SendToIntentAction, text: string, language: Language): boolean {
    return (action.extractionPatterns?.[language] ?? []).some(pattern => compilePattern(pattern).regex.test(text));
}

export function fillPayload(template: unknown, values: Record<string, string | number>): unknown {
    if (Array.isArray(template)) {
        return template.map(item => fillPayload(item, values));
    }
    if (template && typeof template === 'object') {
        const object = template as Record<string, unknown>;
        if (Object.keys(object).length === 1 && typeof object.$param === 'string') {
            return values[object.$param];
        }
        return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, fillPayload(value, values)]));
    }
    return template;
}
