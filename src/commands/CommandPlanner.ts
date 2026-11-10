import type { DeviceCatalogView } from '../devices/DeviceResolver';
import type { ActionKind } from '../devices/types';
import type { ParsedText } from '../nlp/EntityParser';
import { normalizedValue } from './ValueNormalizer';
import type { PlannedAction } from './types';

export type PlanOutcome = { plan: PlannedAction } | { clarification: 'value' } | { error: string };

export function planAction(
    catalog: DeviceCatalogView,
    deviceId: string,
    action: ActionKind,
    parsed: ParsedText,
): PlanOutcome {
    const device = catalog.list().find(item => item.id === deviceId);
    if (!device || device.status === 'missing' || !device.enabled) {
        return { error: 'DEVICE_NOT_FOUND' };
    }
    const capabilities = device.discoveredCapabilities.filter(capability =>
        catalog.isAllowed(deviceId, capability, action),
    );
    if (capabilities.length !== 1) {
        return { error: capabilities.length ? 'AMBIGUOUS_CAPABILITY' : 'ACTION_NOT_APPROVED' };
    }
    const capability = capabilities[0];
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
