import type { ActionKind, Capability } from '../devices/types';
import type { ParsedText } from '../nlp/EntityParser';

export function normalizedValue(
    action: ActionKind,
    capability: Capability,
    parsed: ParsedText,
): boolean | number | string | undefined {
    if (action === 'turnOn') {
        return capability.mapping?.on ?? true;
    }
    if (action === 'turnOff') {
        return capability.mapping?.off ?? false;
    }
    if (action !== 'setLevel' && action !== 'setTemperature') {
        return undefined;
    }
    const candidates = parsed.entities.filter(
        item => item.type === 'number' || item.type === 'percent' || item.type === 'temperature',
    );
    if (candidates.length !== 1) {
        return undefined;
    }
    const entity = candidates[0];
    if (action === 'setLevel' && entity.type === 'temperature') {
        return undefined;
    }
    if (action === 'setTemperature' && entity.type === 'percent') {
        return undefined;
    }
    if (typeof entity.value !== 'number' || !Number.isFinite(entity.value)) {
        return undefined;
    }
    let value = entity.value;
    if (action === 'setLevel' && entity.type === 'percent') {
        if (value < 0 || value > 100 || capability.min === undefined || capability.max === undefined) {
            return undefined;
        }
        value = capability.min + ((capability.max - capability.min) * value) / 100;
    }
    if (capability.mapping?.scale !== undefined) {
        value *= capability.mapping.scale;
    }
    if (capability.mapping?.offset !== undefined) {
        value += capability.mapping.offset;
    }
    if (
        (capability.min !== undefined && value < capability.min) ||
        (capability.max !== undefined && value > capability.max)
    ) {
        return undefined;
    }
    if (capability.enumValues && !capability.enumValues.includes(value)) {
        return undefined;
    }
    return value;
}
