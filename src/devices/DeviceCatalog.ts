import { DeviceRegistry } from './DeviceRegistry';
import type { ActionKind, BooleanWordOverrides, Capability, DeviceRecord, DeviceStore } from './types';
import type { DeviceRepository } from '../storage/DeviceRepository';
import type { RelativeProfiles } from '../commands/RelativeValue';
export class DeviceCatalog {
    private queue: Promise<void> = Promise.resolve();
    private constructor(
        private registry: DeviceRegistry,
        private readonly repository: DeviceRepository,
    ) {}
    public static async load(repository: DeviceRepository): Promise<DeviceCatalog> {
        return new DeviceCatalog(new DeviceRegistry(await repository.load()), repository);
    }
    public list(): DeviceRecord[] {
        return this.registry.list();
    }
    public getRelativeProfiles(): RelativeProfiles {
        return this.registry.getRelativeProfiles();
    }
    public getCustomColors(): NonNullable<DeviceStore['customColors']> {
        return this.registry.getCustomColors();
    }
    public async setRelativeProfiles(profiles: RelativeProfiles): Promise<void> {
        await this.update(registry => registry.setRelativeProfiles(profiles));
    }
    public async setCustomColors(colors: DeviceStore['customColors']): Promise<void> {
        await this.update(registry => registry.setCustomColors(colors));
    }
    public async setDeviceRelativeProfiles(
        deviceId: string,
        stateId: string,
        profiles: RelativeProfiles,
    ): Promise<void> {
        await this.update(registry => registry.setDeviceRelativeProfiles(deviceId, stateId, profiles));
    }

    public isAllowed(deviceId: string, capability: Capability, action: ActionKind): boolean {
        return this.registry.isAllowed(deviceId, capability, action);
    }
    public async reconcile(devices: DeviceRecord[]): Promise<void> {
        await this.update(registry => registry.reconcile(devices));
    }
    public async setEnabled(deviceId: string, enabled: boolean): Promise<void> {
        await this.update(registry => registry.setEnabled(deviceId, enabled));
    }
    public async setAliases(deviceId: string, aliases: DeviceRecord['aliases']): Promise<void> {
        await this.update(registry => registry.setAliases(deviceId, aliases));
    }
    public async setBooleanWords(deviceId: string, overrides: BooleanWordOverrides): Promise<void> {
        await this.update(registry => registry.setBooleanWords(deviceId, overrides));
    }
    public async approve(deviceId: string, stateId: string, action: ActionKind): Promise<void> {
        await this.update(registry => registry.approve(deviceId, stateId, action));
    }
    public async approveMany(
        deviceId: string,
        approvals: Array<{ stateId: string; action: ActionKind }>,
    ): Promise<void> {
        await this.update(registry => registry.approveMany(deviceId, approvals));
    }
    public async revoke(deviceId: string, stateId: string, action: ActionKind): Promise<void> {
        await this.update(registry => registry.revoke(deviceId, stateId, action));
    }
    public async revokeMany(
        deviceId: string,
        revocations: Array<{ stateId: string; action: ActionKind }>,
    ): Promise<void> {
        await this.update(registry => registry.revokeMany(deviceId, revocations));
    }

    private async update(change: (registry: DeviceRegistry) => void): Promise<void> {
        const operation = this.queue.then(async () => {
            const next = new DeviceRegistry(this.registry.snapshot());
            change(next);
            await this.repository.save(next.snapshot());
            this.registry = next;
        });
        this.queue = operation.catch(() => undefined);
        return operation;
    }
}
