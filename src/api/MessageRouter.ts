import { randomUUID } from 'node:crypto';
import { validateCommandRequest } from './RequestValidator';
import type { CommandController } from '../commands/CommandController';
import type { DeviceCatalog } from '../devices/DeviceCatalog';
import type { ActionKind } from '../devices/types';
import { capabilityName } from '../devices/CapabilityName';
import { defaultLanguage, isSupportedLanguage } from '../i18n/LanguageConfig';
import type { IntentRepository } from '../nlp/IntentRepository';
import type { ModelRepository } from '../nlp/ModelRepository';
import { TrainingManager } from '../nlp/TrainingManager';
import { systemIntents } from '../nlp/TrainingData';
import { NlpJsProvider } from '../nlp/NlpJsProvider';
import type { IntentDefinition } from '../nlp/types';
import type { TestLabHistoryRepository } from '../storage/TestLabHistoryRepository';
import type { AdapterTimers } from '../shared/AdapterTimers';

interface MessageContext {
    from: string;
    user?: string;
}

interface RouterOptions {
    controller: CommandController;
    catalog: DeviceCatalog;
    intentRepository: IntentRepository;
    modelRepository: ModelRepository;
    testLabHistory: TestLabHistoryRepository;
    timers: AdapterTimers;
    getUserIntents: () => IntentDefinition[];
    setUserIntents: (intents: IntentDefinition[]) => void;
    setModel: (model: NlpJsProvider, version: string) => void;
    modelReady: () => boolean;
    rescanDevices: () => Promise<void>;
    isAdmin: (context: MessageContext) => Promise<boolean>;
    diagnostics: () => Record<string, unknown>;
}

type Payload = Record<string, unknown>;

export class MessageRouter {
    private readonly rate = new Map<string, { since: number; count: number }>();
    private job:
        | {
              id: string;
              status: 'running' | 'completed' | 'failed';
              version?: string;
              regressionPassed?: number;
              regressionTotal?: number;
              error?: string;
          }
        | undefined;

    public constructor(private readonly options: RouterOptions) {}

    public async handle(command: string, message: unknown, context: MessageContext): Promise<unknown> {
        try {
            if (JSON.stringify(message)?.length > 65_536) {
                return { error: 'REQUEST_TOO_LARGE' };
            }
            const payload: Payload =
                message && typeof message === 'object' && !Array.isArray(message) ? (message as Payload) : {};
            if (command === 'processText') {
                if (!this.permit(context.from)) {
                    return { error: 'RATE_LIMITED' };
                }
                return this.options.controller.process(
                    validateCommandRequest(message),
                    `${context.from}:${context.user ?? ''}`,
                );
            }
            if (!(await this.options.isAdmin(context))) {
                return { error: 'ADMIN_REQUIRED' };
            }
            if (command === 'processTestLab') {
                if (!this.permit(context.from)) {
                    return { error: 'RATE_LIMITED' };
                }
                const request = validateCommandRequest(message);
                if (!request.sessionId) {
                    return { error: 'SESSION_REQUIRED' };
                }
                const result = await this.options.controller.process(request, `${context.from}:${context.user ?? ''}`);
                try {
                    await this.options.testLabHistory.append(request, result);
                } catch {
                    return { ...result, historyError: 'HISTORY_SAVE_FAILED' };
                }
                return result;
            }
            if (command === 'listTestLabSessions') {
                return { sessions: await this.options.testLabHistory.list() };
            }
            if (command === 'getTestLabSession') {
                return { session: await this.options.testLabHistory.get(this.string(payload.sessionId)) };
            }
            if (command === 'deleteTestLabSession') {
                await this.options.testLabHistory.delete(this.string(payload.sessionId));
                return { status: 'deleted' };
            }
            if (command === 'listDevices') {
                const offset = this.int(payload.offset, 0, 100_000, 0);
                const limit = this.int(payload.limit, 1, 100, 50);
                const filter =
                    typeof payload.filter === 'string' ? payload.filter.toLocaleLowerCase().slice(0, 100) : '';
                const room = typeof payload.room === 'string' ? payload.room.slice(0, 200) : '';
                const functionId = typeof payload.functionId === 'string' ? payload.functionId.slice(0, 200) : '';
                const capability = typeof payload.capability === 'string' ? payload.capability.slice(0, 100) : '';
                const language = isSupportedLanguage(payload.language) ? payload.language : defaultLanguage();
                const current = this.options.catalog
                    .list()
                    .filter(device => device.status !== 'missing' && device.discoveredCapabilities.length > 0);
                const devices = current.filter(
                    device =>
                        (!filter ||
                            device.displayName.toLocaleLowerCase().includes(filter) ||
                            device.id.toLocaleLowerCase().includes(filter) ||
                            device.discoveredCapabilities.some(item =>
                                capabilityName(item, language).toLocaleLowerCase(language).includes(filter),
                            )) &&
                        (!room ||
                            (room === '__none__' ? device.roomIds.length === 0 : device.roomIds.includes(room))) &&
                        (!functionId ||
                            (functionId === '__none__'
                                ? device.functionIds.length === 0
                                : device.functionIds.includes(functionId))) &&
                        (!capability ||
                            (capability === '__none__'
                                ? device.discoveredCapabilities.length === 0
                                : device.discoveredCapabilities.some(
                                      item =>
                                          capabilityName(item, language).toLocaleLowerCase(language) ===
                                          capability.toLocaleLowerCase(language),
                                  ))),
                );
                const enumOptions = (
                    kind: 'roomIds' | 'functionIds',
                ): Array<{ id: string; name: string | Record<string, string> }> =>
                    [...new Set(current.flatMap(device => device[kind]))].sort().map(id => ({
                        id,
                        name: current.find(device => device.enumNames?.[id])?.enumNames?.[id] ?? id,
                    }));
                return {
                    total: devices.length,
                    devices: devices.slice(offset, offset + limit),
                    rooms: enumOptions('roomIds'),
                    functions: enumOptions('functionIds'),
                    capabilities: [
                        ...new Map(
                            current
                                .flatMap(device => device.discoveredCapabilities)
                                .map(item => {
                                    const name = capabilityName(item, language);
                                    return [name.toLocaleLowerCase(language), name] as const;
                                }),
                        ).values(),
                    ].sort((a, b) => a.localeCompare(b, language)),
                };
            }
            if (command === 'getDiagnostics') {
                return this.options.diagnostics();
            }
            if (command === 'rescanDevices') {
                await this.options.rescanDevices();
                return { status: 'updated' };
            }
            if (command === 'getTrainingStatus') {
                if (this.job) {
                    return this.job;
                }
                const active = await this.options.modelRepository.loadActive();
                return {
                    status: 'idle',
                    modelVersion: active?.metadata.version,
                    regressionPassed: active?.metadata.regressionPassed,
                    regressionTotal: active?.metadata.regressionTotal,
                };
            }
            if (command === 'updateDevice') {
                return await this.updateDevice(payload);
            }
            if (command === 'listIntents') {
                return { intents: [...systemIntents(), ...this.options.getUserIntents()] };
            }
            if (command === 'saveIntent') {
                return this.saveIntent(payload);
            }
            if (command === 'deleteIntent') {
                return this.deleteIntent(payload);
            }
            if (command === 'exportIntents') {
                return { schemaVersion: 1, intents: this.options.getUserIntents() };
            }
            if (command === 'importIntents') {
                if (payload.schemaVersion !== 1 || !Array.isArray(payload.intents)) {
                    throw new Error('Invalid intent import');
                }
                const intents = payload.intents as IntentDefinition[];
                await this.options.intentRepository.save(intents);
                this.options.setUserIntents(intents);
                return { status: 'imported', count: intents.length };
            }
            if (command === 'trainModel') {
                if (!this.options.modelReady()) {
                    return { error: 'MODEL_INITIALIZING' };
                }
                return this.trainModel();
            }
            if (command === 'rollbackModel') {
                if (!this.options.modelReady() || this.job?.status === 'running') {
                    return { error: 'MODEL_BUSY' };
                }
                await this.options.modelRepository.rollback();
                const loaded = await this.options.modelRepository.loadActive();
                if (!loaded) {
                    throw new Error('No model after rollback');
                }
                const provider = new NlpJsProvider();
                await provider.load(loaded.model);
                this.options.setModel(provider, loaded.metadata.version);
                return { status: 'ready', modelVersion: loaded.metadata.version };
            }
            return { error: 'UNKNOWN_COMMAND' };
        } catch (error) {
            return { error: error instanceof Error ? error.message : 'UNKNOWN_ERROR' };
        }
    }

    private async updateDevice(payload: Payload): Promise<unknown> {
        const deviceId = this.string(payload.deviceId);
        if (!this.options.catalog.list().some(device => device.id === deviceId)) {
            throw new Error('Unknown device');
        }
        if (
            payload.enabled === undefined &&
            payload.aliases === undefined &&
            payload.approval === undefined &&
            payload.approvals === undefined &&
            payload.revocations === undefined
        ) {
            throw new Error('No device update');
        }
        if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') {
            throw new Error('Invalid enabled value');
        }
        if (
            payload.aliases !== undefined &&
            (!payload.aliases || typeof payload.aliases !== 'object' || Array.isArray(payload.aliases))
        ) {
            throw new Error('Invalid aliases');
        }
        let approval: Payload | undefined;
        if (payload.approval !== undefined) {
            if (!payload.approval || typeof payload.approval !== 'object' || Array.isArray(payload.approval)) {
                throw new Error('Invalid approval');
            }
            approval = payload.approval as Payload;
            this.string(approval.stateId);
            this.string(approval.action);
            if (typeof approval.approved !== 'boolean') {
                throw new Error('Invalid approval value');
            }
        }
        let approvals: Array<{ stateId: string; action: ActionKind }> | undefined;
        if (payload.approvals !== undefined) {
            if (
                payload.enabled !== undefined ||
                payload.aliases !== undefined ||
                payload.approval !== undefined ||
                payload.revocations !== undefined ||
                !Array.isArray(payload.approvals) ||
                payload.approvals.length < 1 ||
                payload.approvals.length > 50
            ) {
                throw new Error('Invalid approvals');
            }
            approvals = payload.approvals.map(item => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    throw new Error('Invalid approvals');
                }
                const entry = item as Payload;
                return { stateId: this.string(entry.stateId), action: this.string(entry.action) as ActionKind };
            });
            if (new Set(approvals.map(item => `${item.action}:${item.stateId}`)).size !== approvals.length) {
                throw new Error('Duplicate approvals');
            }
        }
        let revocations: Array<{ stateId: string; action: ActionKind }> | undefined;
        if (payload.revocations !== undefined) {
            if (
                payload.enabled !== undefined ||
                payload.aliases !== undefined ||
                payload.approval !== undefined ||
                payload.approvals !== undefined ||
                !Array.isArray(payload.revocations) ||
                payload.revocations.length < 1 ||
                payload.revocations.length > 50
            ) {
                throw new Error('Invalid revocations');
            }
            revocations = payload.revocations.map(item => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    throw new Error('Invalid revocations');
                }
                const entry = item as Payload;
                return { stateId: this.string(entry.stateId), action: this.string(entry.action) as ActionKind };
            });
            if (new Set(revocations.map(item => `${item.action}:${item.stateId}`)).size !== revocations.length) {
                throw new Error('Duplicate revocations');
            }
        }
        if (payload.enabled !== undefined) {
            await this.options.catalog.setEnabled(deviceId, payload.enabled);
        }
        if (payload.aliases !== undefined) {
            await this.options.catalog.setAliases(deviceId, payload.aliases);
        }
        if (approval) {
            const stateId = this.string(approval.stateId);
            const action = this.string(approval.action) as ActionKind;
            if (approval.approved === true) {
                await this.options.catalog.approve(deviceId, stateId, action);
            } else if (approval.approved === false) {
                await this.options.catalog.revoke(deviceId, stateId, action);
            } else {
                throw new Error('Invalid approval value');
            }
        }
        if (approvals) {
            await this.options.catalog.approveMany(deviceId, approvals);
        }
        if (revocations) {
            await this.options.catalog.revokeMany(deviceId, revocations);
        }
        return { device: this.options.catalog.list().find(device => device.id === deviceId) };
    }

    private async saveIntent(payload: Payload): Promise<unknown> {
        const intent = payload.intent as IntentDefinition;
        if (!intent || typeof intent !== 'object') {
            throw new Error('Invalid intent');
        }
        const current = this.options.getUserIntents().filter(item => item.id !== intent.id);
        const next = [...current, intent];
        await this.options.intentRepository.save(next);
        this.options.setUserIntents(next);
        return { status: 'saved', intentId: intent.id };
    }

    private async deleteIntent(payload: Payload): Promise<unknown> {
        const id = this.string(payload.id);
        const next = this.options.getUserIntents().filter(item => item.id !== id);
        await this.options.intentRepository.save(next);
        this.options.setUserIntents(next);
        return { status: 'deleted', intentId: id };
    }

    private trainModel(): unknown {
        if (this.job?.status === 'running') {
            return { error: 'TRAINING_ALREADY_RUNNING', jobId: this.job.id };
        }
        const job = { id: randomUUID(), status: 'running' as const };
        this.job = job;
        void new TrainingManager(this.options.modelRepository, this.options.timers)
            .train([...systemIntents(), ...this.options.getUserIntents()])
            .then(result => {
                this.options.setModel(result.engine, result.metadata.version);
                this.job = {
                    id: job.id,
                    status: 'completed',
                    version: result.metadata.version,
                    regressionPassed: result.metadata.regressionPassed,
                    regressionTotal: result.metadata.regressionTotal,
                };
            })
            .catch(error => {
                this.job = { id: job.id, status: 'failed', error: String(error) };
            });
        return { jobId: job.id, status: job.status };
    }

    private permit(client: string): boolean {
        const now = Date.now();
        const entry = this.rate.get(client);
        if (!entry || now - entry.since >= 60_000) {
            this.rate.set(client, { since: now, count: 1 });
            return true;
        }
        entry.count++;
        return entry.count <= 30;
    }

    private int(value: unknown, min: number, max: number, fallback: number): number {
        return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
    }

    private string(value: unknown): string {
        if (typeof value !== 'string' || !value || value.length > 200) {
            throw new Error('Invalid string');
        }
        return value;
    }
}
