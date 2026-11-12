import * as utils from '@iobroker/adapter-core';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MessageRouter } from './api/MessageRouter';
import { CommandController } from './commands/CommandController';
import type { DeviceIO } from './commands/types';
import { discoverDevices } from './devices/DeviceDiscovery';
import { DeviceCatalog } from './devices/DeviceCatalog';
import type { ObjectSnapshot } from './devices/types';
import { DeviceRepository } from './storage/DeviceRepository';
import { IntentRepository } from './nlp/IntentRepository';
import { ModelRepository } from './nlp/ModelRepository';
import type { NlpJsProvider } from './nlp/NlpJsProvider';
import { TrainingManager, trainingHash } from './nlp/TrainingManager';
import { systemIntents } from './nlp/TrainingData';
import type { IntentDefinition } from './nlp/types';
import { AuditRepository } from './storage/AuditRepository';
import { TestLabHistoryRepository } from './storage/TestLabHistoryRepository';
import { defaultLanguage, isSupportedLanguage } from './i18n/LanguageConfig';
import type { AdapterTimers } from './shared/AdapterTimers';

const MAX_DISCOVERY_OBJECTS = 100_000;
const DEVICE_IO_TIMEOUT_MS = 15_000;

async function withTimeout<T>(operation: Promise<T>, timers: AdapterTimers): Promise<T> {
    let timer: ioBroker.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = timers.setTimeout(() => reject(new Error('DEVICE_IO_TIMEOUT')), DEVICE_IO_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timer !== undefined && timer !== null) {
            timers.clearTimeout(timer);
        }
    }
}

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
    private modelVersion?: string;
    private userIntents: IntentDefinition[] = [];
    private router?: MessageRouter;
    private lastError?: string;
    private discoveryTimer?: ioBroker.Timeout;
    private updateQueue: Promise<void> = Promise.resolve();
    private inputQueue: Promise<void> = Promise.resolve();
    private started = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'smart-text2command' });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
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
            await this.scanObjects();
            this.subscribeForeignObjects('*');
            this.subscribeStates('input.text');
            this.started = true;
            this.initializeRouter();
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
            this.userIntents = intents;
            const repository = new ModelRepository(join(dataDir, 'models'));
            const trainingIntents = [...systemIntents(), ...intents];
            const existing = await repository.loadActive();
            if (existing?.metadata.trainingHash !== trainingHash(trainingIntents)) {
                await this.setState('info.modelStatus', 'training', true);
            }
            const result = await new TrainingManager(repository, this).loadOrTrain(trainingIntents);
            this.model = result.engine;
            this.modelVersion = result.metadata.version;
            await this.setState('info.modelStatus', 'ready', true);
        } catch (error) {
            this.log.error(`NLP model initialization failed: ${String(error)}`);
            await this.setState('info.modelStatus', 'error', true);
        }
    }

    private initializeRouter(): void {
        const dataDir = utils.getAbsoluteInstanceDataDir(this);
        const io: DeviceIO = {
            getObject: async id => {
                const object = await withTimeout(this.getForeignObjectAsync(id), this);
                return object ? snapshot(id, object) : undefined;
            },
            getState: async id => {
                const state = await withTimeout(this.getForeignStateAsync(id), this);
                return state ? { val: state.val } : undefined;
            },
            setState: async (id, value) => {
                await withTimeout(this.setForeignStateAsync(id, value, false), this);
            },
        };
        const controller = new CommandController(
            this.catalog!,
            io,
            () => (this.model ? { engine: this.model, version: this.modelVersion } : undefined),
            () => this.userIntents,
            new AuditRepository(join(dataDir, 'audit-v1.json')),
            isSupportedLanguage((this.config as { defaultLanguage?: string }).defaultLanguage)
                ? (this.config as { defaultLanguage: string }).defaultLanguage
                : defaultLanguage(),
        );
        this.router = new MessageRouter({
            controller,
            catalog: this.catalog!,
            intentRepository: new IntentRepository(join(dataDir, 'training', 'user-intents-v1.json')),
            modelRepository: new ModelRepository(join(dataDir, 'models')),
            testLabHistory: new TestLabHistoryRepository(join(dataDir, 'test-lab-history-v1.json')),
            timers: this,
            getUserIntents: () => this.userIntents,
            setUserIntents: intents => {
                this.userIntents = intents;
            },
            setModel: (model, version) => {
                this.model = model;
                this.modelVersion = version;
                void this.setState('info.modelStatus', 'ready', true);
            },
            modelReady: () => !!this.model,
            rescanDevices: async () => {
                const operation = this.updateQueue.then(() => this.scanObjects());
                this.updateQueue = operation.catch(() => undefined);
                await operation;
            },
            isAdmin: context => this.isAdmin(context),
            diagnostics: () => ({
                modelStatus: this.model ? 'ready' : 'unavailable',
                modelVersion: this.modelVersion,
                deviceCount: this.catalog?.list().filter(device => device.status !== 'missing').length ?? 0,
                approvedDevices:
                    this.catalog
                        ?.list()
                        .filter(
                            device =>
                                device.status !== 'missing' &&
                                device.enabled &&
                                Object.keys(device.approvedCapabilities).length > 0,
                        ).length ?? 0,
                lastError: this.lastError,
            }),
        });
    }

    private async isAdmin(context: { from: string; user?: string }): Promise<boolean> {
        if (!/^system\.adapter\.admin\.\d+$/.test(context.from) || !context.user?.startsWith('system.user.')) {
            return false;
        }
        const group = await this.getForeignObjectAsync('system.group.administrator');
        return (
            group?.type === 'group' &&
            Array.isArray(group.common.members) &&
            group.common.members.includes(context.user as `system.user.${string}`)
        );
    }

    private onMessage(message: ioBroker.Message): void {
        if (!message?.callback || !this.router) {
            return;
        }
        void this.router
            .handle(message.command, message.message, { from: message.from, user: message.user })
            .then(result => this.sendTo(message.from, message.command, result, message.callback))
            .catch(error => {
                this.lastError = String(error);
                this.log.error(`Message handling failed: ${this.lastError}`);
                this.sendTo(message.from, message.command, { error: 'PROCESSING_ERROR' }, message.callback);
            });
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (id !== `${this.namespace}.input.text` || !state || state.ack) {
            return;
        }
        this.inputQueue = this.inputQueue
            .then(() => this.processInputState(state.val))
            .catch(error => {
                this.lastError = String(error);
                this.log.error(`Analysis state processing failed: ${this.lastError}`);
            });
    }

    private async processInputState(value: unknown): Promise<void> {
        await this.setState('output.status', 'processing', true);
        try {
            if (typeof value !== 'string' || !value.trim() || value.length > 1000) {
                throw new Error('INVALID_TEXT');
            }
            const result = await this.router!.handle(
                'processText',
                { requestId: randomUUID(), text: value, mode: 'analyze' },
                { from: 'state.input.text' },
            );
            const response =
                result && typeof result === 'object' && 'response' in result ? String(result.response) : '';
            const serialized = JSON.stringify(result);
            if (serialized.length > 16_384) {
                throw new Error('RESULT_TOO_LARGE');
            }
            await this.setState('output.response', response.slice(0, 2000), true);
            await this.setState('output.result', serialized, true);
            await this.setState(
                'output.status',
                result && typeof result === 'object' && 'error' in result ? 'error' : 'done',
                true,
            );
        } catch (error) {
            this.lastError = String(error);
            await this.setState('output.result', JSON.stringify({ error: this.lastError }), true);
            await this.setState('output.status', 'error', true);
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
        if (this.discoveryTimer !== undefined && this.discoveryTimer !== null) {
            this.clearTimeout(this.discoveryTimer);
        }
        this.discoveryTimer = this.setTimeout(() => {
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

    private async scanObjects(): Promise<void> {
        const [states, channels, devices, enums] = await Promise.all([
            this.getForeignObjectsAsync('*', 'state'),
            this.getForeignObjectsAsync('*', 'channel'),
            this.getForeignObjectsAsync('*', 'device'),
            this.getForeignObjectsAsync('*', 'enum'),
        ]);
        const entries = [states, channels, devices, enums].flatMap(objects => Object.entries(objects));
        if (entries.length > MAX_DISCOVERY_OBJECTS) {
            throw new Error('Discovery object limit exceeded');
        }
        const current = new Map<string, ObjectSnapshot>();
        for (const [id, object] of entries) {
            if (id.startsWith(`${this.namespace}.`)) {
                continue;
            }
            const value = snapshot(id, object);
            if (value) {
                current.set(id, value);
            }
        }
        this.objects.clear();
        for (const [id, value] of current) {
            this.objects.set(id, value);
        }
        await this.reconcile();
    }

    private onUnload(callback: () => void): void {
        if (this.discoveryTimer !== undefined && this.discoveryTimer !== null) {
            this.clearTimeout(this.discoveryTimer);
        }
        void this.updateQueue.finally(callback);
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new SmartText2command(options);
} else {
    new SmartText2command();
}
