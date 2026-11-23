import type { DeviceCatalogView } from '../devices/DeviceResolver';
import type { Language } from '../types/api';
import type { ActionKind } from '../devices/types';
import { matchesValueDomain } from '../devices/ValueDomain';
import { capabilityNameMatches } from '../devices/CapabilityName';
import type { ValueDomain } from '../devices/ValueDomain';
import type { ParsedText } from '../nlp/EntityParser';
import { normalizedValue } from './ValueNormalizer';
import { colorValue, matchEffectiveColor, normalizeColorName } from './NamedColors';
import type { PlannedAction } from './types';

export type PlanOutcome =
    | { plan: PlannedAction }
    | { clarification: 'value'; stateId: string }
    | { clarification: 'capability'; stateIds: string[] }
    | { error: string };

export function planAction(
    catalog: DeviceCatalogView,
    deviceId: string,
    action: ActionKind,
    parsed: ParsedText,
    language: Language,
    text: string,
    domain?: ValueDomain,
    selectedStateId?: string,
    stringValue?: string,
): PlanOutcome {
    const device = catalog.list().find(item => item.id === deviceId);
    if (!device || device.status === 'missing' || !device.enabled) {
        return { error: 'DEVICE_NOT_FOUND' };
    }
    const available = device.discoveredCapabilities.filter(
        capability =>
            catalog.isAllowed(deviceId, capability, action) && matchesValueDomain(capability, domain, language),
    );
    const named = available.filter(capability => capabilityNameMatches(capability, text, language));
    const capabilities = !selectedStateId && named.length ? named : available;
    if (selectedStateId && !capabilities.some(capability => capability.stateId === selectedStateId)) {
        return { error: 'INVALID_SELECTION' };
    }
    const selected = selectedStateId
        ? capabilities.filter(capability => capability.stateId === selectedStateId)
        : capabilities;
    if (selected.length !== 1) {
        return selected.length
            ? { clarification: 'capability', stateIds: selected.map(capability => capability.stateId) }
            : { error: 'ACTION_NOT_APPROVED' };
    }
    const capability = selected[0];
    const operation = action === 'getState' || action === 'getValue' ? 'read' : 'write';
    let preparedStringValue = stringValue;
    if (action === 'setValue' && capability.valueKind === 'string' && capability.role?.startsWith('level.color.')) {
        if (capability.role !== 'level.color.rgb' && capability.role !== 'level.color.rgbw') {
            return { error: 'COLOR_FORMAT_UNSUPPORTED' };
        }
        if (stringValue !== undefined) {
            const color = matchEffectiveColor(stringValue, language, catalog.getCustomColors?.());
            const hex =
                color && normalizeColorName(stringValue) === normalizeColorName(color.name)
                    ? color.hex
                    : stringValue.trim();
            preparedStringValue =
                colorValue(hex, capability.role) ??
                (capability.role === 'level.color.rgbw' && /^#[0-9a-f]{8}$/iu.test(hex)
                    ? hex.toLowerCase()
                    : undefined);
        }
    }
    const value = normalizedValue(action, capability, parsed, preparedStringValue);
    if (operation === 'write' && value === undefined) {
        return stringValue !== undefined ||
            parsed.entities.some(entity => ['number', 'percent', 'temperature'].includes(entity.type))
            ? { error: 'INVALID_VALUE' }
            : { clarification: 'value', stateId: capability.stateId };
    }
    return {
        plan: {
            deviceId,
            action,
            capability,
            operation,
            stateId: operation === 'read' ? (capability.readStateId ?? capability.stateId) : capability.stateId,
            value,
        },
    };
}
