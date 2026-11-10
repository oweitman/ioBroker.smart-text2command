import type { DeviceIO, PlannedAction, ActionResult } from './types';
import type { PolicyEngine } from './PolicyEngine';

export class CommandExecutor {
    public constructor(
        private readonly io: DeviceIO,
        private readonly policy: PolicyEngine,
    ) {}

    public async execute(plan: PlannedAction): Promise<ActionResult> {
        const decision = await this.policy.validate(plan);
        if (!decision.allowed) {
            return { deviceId: plan.deviceId, stateId: plan.stateId, status: 'rejected', message: decision.code };
        }
        try {
            if (plan.operation === 'read') {
                const state = await this.io.getState(plan.stateId);
                if (!state) {
                    return {
                        deviceId: plan.deviceId,
                        stateId: plan.stateId,
                        status: 'failed',
                        message: 'STATE_UNAVAILABLE',
                    };
                }
                const value = state.val;
                if (
                    value !== null &&
                    typeof value !== 'boolean' &&
                    typeof value !== 'number' &&
                    typeof value !== 'string'
                ) {
                    return {
                        deviceId: plan.deviceId,
                        stateId: plan.stateId,
                        status: 'failed',
                        message: 'INVALID_STATE_VALUE',
                    };
                }
                return { deviceId: plan.deviceId, stateId: plan.stateId, status: 'confirmed', value };
            }
            await this.io.setState(plan.stateId, plan.value!);
            return { deviceId: plan.deviceId, stateId: plan.stateId, status: 'accepted' };
        } catch (error) {
            return { deviceId: plan.deviceId, stateId: plan.stateId, status: 'failed', message: String(error) };
        }
    }
}
