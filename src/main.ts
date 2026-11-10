import * as utils from '@iobroker/adapter-core';
import { join } from 'node:path';
import { discoverDevices } from './devices/DeviceDiscovery';
import { DeviceCatalog } from './devices/DeviceCatalog';
import type { ObjectSnapshot } from './devices/types';
import { DeviceRepository } from './storage/DeviceRepository';
import { IntentRepository } from './nlp/IntentRepository';
import { ModelRepository } from './nlp/ModelRepository';
import { NlpJsProvider } from './nlp/NlpJsProvider';
import { TrainingManager } from './nlp/TrainingManager';
import { systemIntents } from './nlp/TrainingData';

const MAX_DISCOVERY_OBJECTS = 100_000;

function snapshot(id: string, object: ioBroker.Object): ObjectSnapshot | undefined {
    if (object.type !== 'device' && object.type !== 'channel' && object.type !== 'state' && object.type !== 'enum') {
        return undefined;
    }
    return { id, type: object.type, common: object.common as ObjectSnapshot['common'] };
}

class SmartText2command extends utils.Adapter {
    private readonly objects = new Map<string, ObjectSnapshot>();
    private catalog?: DeviceCatalog;
    private model?: NlpJsProvider;
    private discoveryTimer?: ReturnType<typeof setTimeout>;
    private updateQueue: Promise<void> = Promise.resolve();
    private started = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'smart-text2command' });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        try {
            const repository = new DeviceRepository(join(utils.getAbsoluteInstanceDataDir(this), 'devices-v1.json'));
            this.catalog = await DeviceCatalog.load(repository);
        } catch (error) {
            this.log.error(`Device approvals could not be loaded; discovery remains disabled: ${String(error)}`);
            return;
        }
        try {
            const all = await this.getForeignObjectsAsync('*');
            const entries = Object.entries(all);
            if (entries.length > MAX_DISCOVERY_OBJECTS) {
                throw new Error('Discovery object limit exceeded');
            }
            for (const [id, object] of entries) {
                if (id.startsWith(`${this.namespace}.`)) {
                    continue;
                }
                const value = snapshot(id, object);
                if (value) {
                    this.objects.set(id, value);
                }
            }
            await this.reconcile();
            this.subscribeForeignObjects('*');
            this.started = true;
            void this.initializeModel().catch(error => this.log.error(`NLP status update failed: ${String(error)}`));
        } catch (error) {
            this.log.error(`Device discovery failed: ${String(error)}`);
        }
    }

    private async initializeModel(): Promise<void> {
        try {
            await this.setState('info.modelStatus', 'loading', true);
            const dataDir = utils.getAbsoluteInstanceDataDir(this);
            const intents = await new IntentRepository(join(dataDir, 'training', 'user-intents-v1.json')).load();
            const repository = new ModelRepository(join(dataDir, 'models'));
            const existing = await repository.loadActive();
            if (existing) {
                const provider = new NlpJsProvider();
                await provider.load(existing.model);
                this.model = provider;
            } else {
                await this.setState('info.modelStatus', 'training', true);
                const result = await new TrainingManager(repository).train([...systemIntents(), ...intents]);
                this.model = result.engine;
            }
            await this.setState('info.modelStatus', 'ready', true);
        } catch (error) {
            this.log.error(`NLP model initialization failed: ${String(error)}`);
            await this.setState('info.modelStatus', 'error', true);
        }
    }

    private onObjectChange(id: string, object: ioBroker.Object | null | undefined): void {
        if (!this.started || id.startsWith(`${this.namespace}.`)) {
            return;
        }
        const value = object ? snapshot(id, object) : undefined;
        if (value) {
            this.objects.set(id, value);
        } else {
            this.objects.delete(id);
        }
        if (this.discoveryTimer) {
            clearTimeout(this.discoveryTimer);
        }
        this.discoveryTimer = setTimeout(() => {
            this.updateQueue = this.updateQueue
                .then(() => this.reconcile())
                .catch(error => {
                    this.log.error(`Device discovery update failed: ${String(error)}`);
                });
        }, 300);
    }

    private async reconcile(): Promise<void> {
        if (this.objects.size > MAX_DISCOVERY_OBJECTS) {
            throw new Error('Discovery object limit exceeded');
        }
        await this.catalog!.reconcile(discoverDevices([...this.objects.values()]));
        await this.setState(
            'info.deviceCount',
            this.catalog!.list().filter(device => device.status !== 'missing').length,
            true,
        );
    }

    private onUnload(callback: () => void): void {
        if (this.discoveryTimer) {
            clearTimeout(this.discoveryTimer);
        }
        void this.updateQueue.finally(callback);
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new SmartText2command(options);
} else {
    new SmartText2command();
}
