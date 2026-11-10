import { mapCapability } from '../devices/CapabilityMapper';
import type { DeviceCatalogView } from '../devices/DeviceResolver';
import type { DeviceIO, PlannedAction } from './types';

export class PolicyEngine {
    public constructor(
        private readonly catalog: DeviceCatalogView,
        private readonly io: DeviceIO,
    ) {}

    public async validate(plan: PlannedAction): Promise<{ allowed: true } | { allowed: false; code: string }> {
        if (!this.catalog.isAllowed(plan.deviceId, plan.capability, plan.action)) {
            return { allowed: false, code: 'ACTION_NOT_APPROVED' };
        }
        const object = await this.io.getObject(plan.capability.stateId);
        const current = object ? mapCapability(object) : undefined;
        if (!current || current.fingerprint !== plan.capability.fingerprint) {
            return { allowed: false, code: 'CAPABILITY_CHANGED' };
        }
        if (
            plan.operation === 'write' &&
            (!current.writable || plan.value === undefined || plan.stateId !== current.stateId)
        ) {
            return { allowed: false, code: 'INVALID_WRITE' };
        }
        if (
            plan.operation === 'read' &&
            (!current.readable || plan.stateId !== (current.readStateId ?? current.stateId))
        ) {
            return { allowed: false, code: 'INVALID_READ' };
        }
        if (plan.value !== undefined && typeof plan.value !== current.valueKind) {
            return { allowed: false, code: 'INVALID_VALUE' };
        }
        if (
            typeof plan.value === 'number' &&
            ((current.min !== undefined && plan.value < current.min) ||
                (current.max !== undefined && plan.value > current.max))
        ) {
            return { allowed: false, code: 'INVALID_VALUE' };
        }
        if (
            plan.value !== undefined &&
            current.enumValues &&
            (typeof plan.value === 'boolean' || !current.enumValues.includes(plan.value))
        ) {
            return { allowed: false, code: 'INVALID_VALUE' };
        }
        return { allowed: true };
    }
}
