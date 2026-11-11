import type { ActionKind, Capability, DeviceRecord, DeviceStore } from './types';
import { capabilityFingerprint } from './CapabilityMapper';

function approvalKey(action: ActionKind, stateId: string): string {
    return `${action}:${stateId}`;
}

function supports(capability: Capability, action: ActionKind): boolean {
    switch (action) {
        case 'turnOn':
        case 'turnOff':
            return capability.kind === 'onOff' && capability.writable;
        case 'setLevel':
            return capability.kind === 'brightness' && capability.writable;
        case 'setTemperature':
            return capability.kind === 'temperatureSetpoint' && capability.writable;
        case 'getState':
            return capability.kind === 'onOff' && capability.readable;
        case 'getValue':
            return (
                (capability.kind === 'readTemperature' ||
                    capability.kind === 'brightness' ||
                    capability.kind === 'temperatureSetpoint') &&
                capability.readable
            );
    }
}

function copy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
export class DeviceRegistry {
    private devices = new Map<string, DeviceRecord>();
    public constructor(saved?: DeviceStore) {
        if (saved) {
            if (saved.schemaVersion !== 1 || !Array.isArray(saved.devices)) {
                throw new Error('Unsupported device store schema');
            }
            for (const device of saved.devices) {
                this.devices.set(device.id, copy(device));
            }
        }
    }
    public list(): DeviceRecord[] {
        return [...this.devices.values()].map(copy).sort((a, b) => a.id.localeCompare(b.id));
    }
    public snapshot(): DeviceStore {
        return { schemaVersion: 1, devices: this.list() };
    }
    public reconcile(discovered: DeviceRecord[]): void {
        const seen = new Set<string>();
        for (const fresh of discovered) {
            seen.add(fresh.id);
            const old = this.devices.get(fresh.id);
            if (!old) {
                this.devices.set(fresh.id, copy(fresh));
                continue;
            }
            const approvedCapabilities = { ...old.approvedCapabilities };
            const capabilities = fresh.discoveredCapabilities.map(capability => ({
                ...capability,
                needsReview: Object.entries(approvedCapabilities).some(
                    ([key, fingerprint]) =>
                        key.endsWith(`:${capability.stateId}`) && fingerprint !== capability.fingerprint,
                ),
            }));
            this.devices.set(fresh.id, {
                ...fresh,
                aliases: old.aliases,
                enabled: old.enabled,
                approvedCapabilities,
                discoveredCapabilities: capabilities,
                status:
                    fresh.status === 'needsReview' ||
                    capabilities.some(capability => capability.needsReview) ||
                    Object.keys(approvedCapabilities).some(
                        key => !capabilities.some(capability => key.endsWith(`:${capability.stateId}`)),
                    )
                        ? 'needsReview'
                        : 'available',
            });
        }
        for (const [id, old] of this.devices) {
            if (!seen.has(id)) {
                this.devices.set(id, { ...old, status: 'missing' });
            }
        }
    }
    public setEnabled(deviceId: string, enabled: boolean): void {
        const device = this.requireDevice(deviceId);
        device.enabled = enabled;
    }
    public setAliases(deviceId: string, aliases: DeviceRecord['aliases']): void {
        const device = this.requireDevice(deviceId);
        for (const values of Object.values(aliases)) {
            if (
                values &&
                (!Array.isArray(values) ||
                    values.some(value => typeof value !== 'string' || !value.trim() || value.length > 100))
            ) {
                throw new Error('Invalid aliases');
            }
        }
        device.aliases = copy(aliases);
    }
    public approve(deviceId: string, stateId: string, action: ActionKind): void {
        const device = this.requireDevice(deviceId);
        if (device.status === 'missing') {
            throw new Error('Device is missing');
        }
        const capability = device.discoveredCapabilities.find(candidate => candidate.stateId === stateId);
        if (!capability) {
            throw new Error('Capability not discovered');
        }
        if (!supports(capability, action)) {
            throw new Error('Action is incompatible with capability');
        }
        for (const [key, fingerprint] of Object.entries(device.approvedCapabilities)) {
            if (key.endsWith(`:${stateId}`) && fingerprint !== capability.fingerprint) {
                delete device.approvedCapabilities[key];
            }
        }
        device.approvedCapabilities[approvalKey(action, stateId)] = capability.fingerprint;
        capability.needsReview = false;
        if (!device.discoveredCapabilities.some(item => item.needsReview)) {
            device.status = 'available';
        }
    }
    public approveMany(deviceId: string, approvals: Array<{ stateId: string; action: ActionKind }>): void {
        for (const approval of approvals) {
            this.approve(deviceId, approval.stateId, approval.action);
        }
    }
    public revoke(deviceId: string, stateId: string, action: ActionKind): void {
        const device = this.requireDevice(deviceId);
        delete device.approvedCapabilities[approvalKey(action, stateId)];
        const capability = device.discoveredCapabilities.find(candidate => candidate.stateId === stateId);
        if (capability) {
            capability.needsReview = Object.entries(device.approvedCapabilities).some(
                ([key, fingerprint]) => key.endsWith(`:${stateId}`) && fingerprint !== capability.fingerprint,
            );
        }
        if (device.status === 'needsReview' && !device.discoveredCapabilities.some(item => item.needsReview)) {
            device.status = 'available';
        }
    }
    public revokeMany(deviceId: string, revocations: Array<{ stateId: string; action: ActionKind }>): void {
        for (const revocation of revocations) {
            this.revoke(deviceId, revocation.stateId, revocation.action);
        }
    }
    public isAllowed(deviceId: string, capability: Capability, action: ActionKind): boolean {
        const device = this.devices.get(deviceId);
        return (
            !!device &&
            device.enabled &&
            device.status !== 'missing' &&
            !capability.needsReview &&
            supports(capability, action) &&
            capabilityFingerprint(capability) === capability.fingerprint &&
            device.approvedCapabilities[approvalKey(action, capability.stateId)] === capability.fingerprint &&
            device.discoveredCapabilities.some(
                item => item.stateId === capability.stateId && item.fingerprint === capability.fingerprint,
            )
        );
    }

    private requireDevice(deviceId: string): DeviceRecord {
        const device = this.devices.get(deviceId);
        if (!device) {
            throw new Error('Unknown device');
        }
        return device;
    }
}
