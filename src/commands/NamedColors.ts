import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from '../types/api';

export interface NamedColor {
    name: string;
    hex: string;
}

export interface NamedTemperature {
    name: string;
    kelvin: number;
}

export function matchNamedTemperature(text: string, language: Language): NamedTemperature | undefined {
    const names = JSON.parse(
        readFileSync(join(__dirname, '../../resources/colors/temperature.json'), 'utf8'),
    ) as Record<Language, NamedTemperature[]>;
    const normalized = normalizeColorName(text);
    return names[language].find(item => normalizeColorName(item.name) === normalized);
}

export function normalizeColorName(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

let cached: Record<string, NamedColor[]> | undefined;

export function namedColors(language: Language): NamedColor[] {
    if (!cached) {
        const source = JSON.parse(readFileSync(join(__dirname, '../../resources/colors/names.json'), 'utf8')) as Record<
            string,
            { de: string | string[]; en: string | string[] }
        >;
        const entries = Object.entries(source);
        cached = Object.fromEntries(
            ['de', 'en'].map(code => {
                const names = entries.flatMap(([hex, labels]) => {
                    const values = labels[code as 'de' | 'en'];
                    return (Array.isArray(values) ? values : [values]).map(name => ({ name, hex: hex.toLowerCase() }));
                });
                const seen = new Map<string, string>();
                for (const item of names) {
                    const key = normalizeColorName(item.name);
                    if (seen.has(key)) {
                        throw new Error(`Ambiguous color name: ${item.name}`);
                    }
                    seen.set(key, item.hex);
                }
                return [code, names.sort((a, b) => b.name.length - a.name.length)];
            }),
        );
    }
    return cached[language] ?? [];
}

export function matchNamedColor(text: string, language: Language): NamedColor | undefined {
    const request = ` ${normalizeColorName(text)} `;
    return namedColors(language).find(color => request.includes(` ${normalizeColorName(color.name)} `));
}

export interface CustomColor extends NamedColor {
    language: Language;
}

export function validateCustomColors(value: unknown): CustomColor[] {
    if (!Array.isArray(value) || value.length > 500) {
        throw new Error('Invalid custom colors');
    }
    const seen = new Set<string>();
    return value.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error('Invalid custom color');
        }
        const { language, name, hex } = item as Record<string, unknown>;
        if (
            (language !== 'de' && language !== 'en') ||
            typeof name !== 'string' ||
            name.length > 100 ||
            !normalizeColorName(name) ||
            typeof hex !== 'string' ||
            !/^#[0-9a-f]{6}$/i.test(hex)
        ) {
            throw new Error('Invalid custom color');
        }
        const key = `${language}:${normalizeColorName(name)}`;
        if (seen.has(key)) {
            throw new Error('Duplicate custom color name');
        }
        seen.add(key);
        return { language, name: name.trim(), hex: hex.toLowerCase() };
    });
}

export function matchEffectiveColor(
    text: string,
    language: Language,
    custom: CustomColor[] = [],
): NamedColor | undefined {
    const overrides = custom.filter(item => item.language === language);
    const overrideNames = new Set(overrides.map(item => normalizeColorName(item.name)));
    const colors = [
        ...overrides,
        ...namedColors(language).filter(item => !overrideNames.has(normalizeColorName(item.name))),
    ];
    const request = ` ${normalizeColorName(text)} `;
    return colors
        .sort((a, b) => normalizeColorName(b.name).length - normalizeColorName(a.name).length)
        .find(color => request.includes(` ${normalizeColorName(color.name)} `));
}

export function colorValue(hex: string, role: string): string | undefined {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) {
        return undefined;
    }
    if (role === 'level.color.rgb') {
        return hex.toLowerCase();
    }
    if (role === 'level.color.rgbw') {
        return `${hex.toLowerCase()}00`;
    }
    return undefined;
}
