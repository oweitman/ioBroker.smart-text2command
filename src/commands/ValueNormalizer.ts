import type { ActionKind, Capability } from '../devices/types';
import type { ParsedText } from '../nlp/EntityParser';

export function normalizedValue(
    action: ActionKind,
    capability: Capability,
    parsed: ParsedText,
    stringValue?: string,
): boolean | number | string | undefined {
    if (action === 'turnOn') {
        return capability.mapping?.on ?? true;
    }
    if (action === 'turnOff') {
        return capability.mapping?.off ?? false;
    }
    if (action === 'press') {
        return true;
    }
    if (action !== 'setValue') {
        return undefined;
    }
    if (capability.valueKind === 'string') {
        return stringValue && (!capability.enumValues || capability.enumValues.includes(stringValue))
            ? stringValue
            : undefined;
    }
    if (capability.valueKind !== 'number') {
        return undefined;
    }
    const candidates = parsed.entities.filter(
        item => item.type === 'number' || item.type === 'percent' || item.type === 'temperature',
    );
    if (candidates.length !== 1) {
        return undefined;
    }
    const entity = candidates[0];
    if (
        entity.type === 'temperature' &&
        !(capability.unit === '°C' || (!capability.unit && capability.role?.endsWith('.temperature') === true))
    ) {
        return undefined;
    }
    if (typeof entity.value !== 'number' || !Number.isFinite(entity.value)) {
        return undefined;
    }
    let value = entity.value;
    if (entity.type === 'percent') {
        const percentageRole = /\.(?:brightness|dimmer|blind|tilt)$/.test(capability.role ?? '');
        if (capability.unit !== '%' && !percentageRole) {
            return undefined;
        }
        if (value < 0 || value > 100) {
            return undefined;
        }
        if (capability.min !== undefined && capability.max !== undefined) {
            value = capability.min + ((capability.max - capability.min) * value) / 100;
        } else if (capability.unit !== '%') {
            return undefined;
        }
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
