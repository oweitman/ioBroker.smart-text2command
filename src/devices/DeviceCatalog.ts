import { DeviceRegistry } from './DeviceRegistry';
import type { ActionKind, DeviceRecord } from './types';
import type { DeviceRepository } from '../storage/DeviceRepository';
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
    public async reconcile(devices: DeviceRecord[]): Promise<void> {
        await this.update(registry => registry.reconcile(devices));
    }
    public async setEnabled(deviceId: string, enabled: boolean): Promise<void> {
        await this.update(registry => registry.setEnabled(deviceId, enabled));
    }
    public async setAliases(deviceId: string, aliases: DeviceRecord['aliases']): Promise<void> {
        await this.update(registry => registry.setAliases(deviceId, aliases));
    }
    public async approve(deviceId: string, stateId: string, action: ActionKind): Promise<void> {
        await this.update(registry => registry.approve(deviceId, stateId, action));
    }
    public async revoke(deviceId: string, stateId: string, action: ActionKind): Promise<void> {
        await this.update(registry => registry.revoke(deviceId, stateId, action));
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
