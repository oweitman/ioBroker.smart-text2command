import type { Language } from '../types/api';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type RelativeProperty =
    | 'brightness'
    | 'temperature'
    | 'colorTemperature'
    | 'volume'
    | 'humidity'
    | 'saturation'
    | 'position'
    | 'tilt'
    | 'fanSpeed';
export type Intensity = 'tiny' | 'small' | 'normal' | 'large' | 'max';
export type RelativeDirection = 'increase' | 'decrease' | 'warmer' | 'cooler' | 'up' | 'down';

export interface RelativeRequest {
    direction: RelativeDirection;
    property?: RelativeProperty;
    intensity: Intensity;
    explicitAmount?: { value: number; unit: string };
    endpoint?: 'min' | 'max';
}

export interface RelativeProfile {
    tiny?: number;
    small?: number;
    normal?: number;
    large?: number;
    max?: number;
    enabled?: boolean;
    inverted?: boolean;
    step?: number;
}

export type RelativeProfiles = Record<string, RelativeProfile>;

const profileRows = JSON.parse(
    readFileSync(join(__dirname, '../../resources/relative/profiles.json'), 'utf8'),
) as Record<string, [number, number, number, number, number]>;
export const profiles = Object.fromEntries(
    Object.entries(profileRows).reduce<
        Array<[RelativeProperty, Record<string, [number, number, number, number, number]>]>
    >((rows, [key, value]) => {
        const [property, unit] = key.split(':') as [RelativeProperty, string];
        const row = rows.find(item => item[0] === property);
        if (row) {
            row[1][unit] = value;
        } else {
            rows.push([property, { [unit]: value }]);
        }
        return rows;
    }, []),
) as Record<RelativeProperty, Partial<Record<string, [number, number, number, number, number]>>>;

const intensityOrder: Intensity[] = ['tiny', 'small', 'normal', 'large', 'max'];

export interface RelativeLanguageRules {
    negation: string;
    directions: Record<RelativeDirection, string>;
    intensities: Record<Exclude<Intensity, 'normal'>, string>;
    properties: Partial<Record<RelativeProperty, string>>;
    amount: string;
    colorSet: string;
    colorVerb: string;
    mediaNext: string;
    mediaPrevious: string;
    unitAliases: Record<string, string[]>;
    endpoints: Array<{
        pattern: string;
        property?: RelativeProperty;
        direction: RelativeDirection;
        value: 'min' | 'max';
    }>;
}
const ruleCache = new Map<Language, RelativeLanguageRules>();
export function relativeLanguageRules(language: Language): RelativeLanguageRules {
    let rules = ruleCache.get(language);
    if (!rules) {
        rules = JSON.parse(
            readFileSync(join(__dirname, '../../resources/relative', `${language}.json`), 'utf8'),
        ) as RelativeLanguageRules;
        ruleCache.set(language, rules);
    }
    return rules;
}

function matches(pattern: string, text: string): boolean {
    return new RegExp(pattern, 'u').test(text);
}

export function parseRelativeRequest(text: string, language: Language): RelativeRequest | undefined {
    const rules = relativeLanguageRules(language);
    const normalized = text
        .toLocaleLowerCase(language)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ß/g, 'ss');
    if (matches(rules.negation, normalized)) {
        return undefined;
    }
    const endpoints = rules.endpoints.filter(item => matches(item.pattern, normalized));
    if (endpoints.length === 1) {
        const endpoint = endpoints[0];
        return {
            direction: endpoint.direction,
            property: endpoint.property,
            intensity: 'normal',
            endpoint: endpoint.value,
        };
    }
    const directions = (Object.entries(rules.directions) as Array<[RelativeDirection, string]>).filter(([, pattern]) =>
        matches(pattern, normalized),
    );
    if (directions.length !== 1) {
        return undefined;
    }
    const intensities = (Object.entries(rules.intensities) as Array<[Intensity, string]>).filter(([, pattern]) =>
        matches(pattern, normalized),
    );
    if (intensities.length > 1) {
        return undefined;
    }
    const intensity = intensities[0]?.[0] ?? 'normal';
    const amount = new RegExp(rules.amount, 'iu').exec(normalized);
    const properties = (Object.entries(rules.properties) as Array<[RelativeProperty, string]>).filter(([, pattern]) =>
        matches(pattern, normalized),
    );
    if (properties.length > 1) {
        return undefined;
    }
    const property = properties[0]?.[0];
    return {
        direction: directions[0][0],
        property,
        intensity,
        ...(amount
            ? {
                  explicitAmount: {
                      value: Number(amount[1].replace(',', '.')),
                      unit:
                          Object.entries(rules.unitAliases).find(([, aliases]) =>
                              aliases.includes(amount[2].replace(/\s/g, '').toLowerCase()),
                          )?.[0] ?? amount[2],
                  },
              }
            : {}),
    };
}

export function relativeTarget(
    current: number,
    min: number,
    max: number,
    property: RelativeProperty,
    unit: string,
    request: RelativeRequest,
    profile: RelativeProfile = {},
): number | undefined {
    if (![current, min, max].every(Number.isFinite) || min >= max || current < min || current > max) {
        return undefined;
    }
    const steps = profiles[property][unit];
    if (!steps || profile.enabled === false) {
        return undefined;
    }
    if (request.endpoint) {
        return request.endpoint === 'min' ? min : max;
    }
    const index = intensityOrder.indexOf(request.intensity);
    if (request.explicitAmount && request.explicitAmount.unit !== unit) {
        return undefined;
    }
    const amount = request.explicitAmount?.value ?? profile[request.intensity] ?? steps[index];
    const delta =
        property === 'temperature' || property === 'humidity' || (request.explicitAmount && unit === 'K')
            ? amount
            : ((max - min) * amount) / 100;
    if (!Number.isFinite(delta) || delta <= 0) {
        return undefined;
    }
    const sign =
        request.direction === 'decrease' || request.direction === 'cooler' || request.direction === 'up' ? -1 : 1;
    const semanticSign =
        property === 'colorTemperature' && (request.direction === 'warmer' || request.direction === 'cooler')
            ? -sign
            : sign;
    const signed = profile.inverted ? -semanticSign : semanticSign;
    const raw = Math.max(min, Math.min(max, current + signed * delta));
    const quantum = profile.step ?? (unit === '°C' ? 0.5 : 1);
    if (!Number.isFinite(quantum) || quantum <= 0) {
        return undefined;
    }
    return Math.max(min, Math.min(max, min + Math.round((raw - min) / quantum) * quantum));
}

export function enumRelativeTarget(
    current: number,
    values: Array<string | number>,
    request: RelativeRequest,
    profile: RelativeProfile = {},
): number | undefined {
    const numeric = values.filter((value): value is number => typeof value === 'number');
    if (
        numeric.length !== values.length ||
        numeric.length < 2 ||
        numeric.some(value => !Number.isFinite(value)) ||
        numeric.some((value, index) => index > 0 && value <= numeric[index - 1]) ||
        profile.enabled === false
    ) {
        return undefined;
    }
    const currentIndex = numeric.indexOf(current);
    if (currentIndex < 0) {
        return undefined;
    }
    const steps = profiles.fanSpeed.enum;
    const count =
        request.explicitAmount?.value ??
        profile[request.intensity] ??
        steps?.[intensityOrder.indexOf(request.intensity)];
    if (request.explicitAmount && request.explicitAmount.unit !== 'enum') {
        return undefined;
    }
    if (count === undefined || !Number.isInteger(count) || count <= 0) {
        return undefined;
    }
    const positive = request.direction === 'increase' || request.direction === 'warmer' || request.direction === 'down';
    const sign = (positive ? 1 : -1) * (profile.inverted ? -1 : 1);
    return numeric[Math.max(0, Math.min(numeric.length - 1, currentIndex + sign * count))];
}

export function validateRelativeProfile(value: unknown): RelativeProfile {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid relative profile');
    }
    const source = value as Record<string, unknown>;
    const result: RelativeProfile = {};
    for (const [key, entry] of Object.entries(source)) {
        if (['tiny', 'small', 'normal', 'large', 'max', 'step'].includes(key)) {
            if (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0 || entry > 10000) {
                throw new Error('Invalid relative profile value');
            }
            Object.assign(result, { [key]: entry });
        } else if (key === 'enabled' || key === 'inverted') {
            if (typeof entry !== 'boolean') {
                throw new Error('Invalid relative profile flag');
            }
            Object.assign(result, { [key]: entry });
        } else {
            throw new Error('Unknown relative profile field');
        }
    }
    return result;
}
