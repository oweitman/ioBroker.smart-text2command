import type { DeviceCatalogView } from '../devices/DeviceResolver';
import type { ActionKind } from '../devices/types';
import { matchesValueDomain } from '../devices/ValueDomain';
import type { ValueDomain } from '../devices/ValueDomain';
import type { ParsedText } from '../nlp/EntityParser';
import { normalizedValue } from './ValueNormalizer';
import type { PlannedAction } from './types';

export type PlanOutcome =
    | { plan: PlannedAction }
    | { clarification: 'value' }
    | { clarification: 'capability'; stateIds: string[] }
    | { error: string };

export function planAction(
    catalog: DeviceCatalogView,
    deviceId: string,
    action: ActionKind,
    parsed: ParsedText,
    domain?: ValueDomain,
    selectedStateId?: string,
): PlanOutcome {
    const device = catalog.list().find(item => item.id === deviceId);
    if (!device || device.status === 'missing' || !device.enabled) {
        return { error: 'DEVICE_NOT_FOUND' };
    }
    const capabilities = device.discoveredCapabilities.filter(
        capability => catalog.isAllowed(deviceId, capability, action) && matchesValueDomain(capability, domain),
    );
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
    const value = normalizedValue(action, capability, parsed);
    if (operation === 'write' && value === undefined) {
        return { clarification: 'value' };
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
