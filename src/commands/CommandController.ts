import type { CommandRequest, Language } from '../types/api';
import type { ActionKind } from '../devices/types';
import { DeviceResolver, roomNames } from '../devices/DeviceResolver';
import type { DeviceCatalogView } from '../devices/DeviceResolver';
import { inferValueDomain, matchesValueDomain } from '../devices/ValueDomain';
import { parseEntities } from '../nlp/EntityParser';
import type { NlpEngine } from '../nlp/NlpEngine';
import type { IntentDefinition } from '../nlp/types';
import { SessionStore } from '../dialog/SessionStore';
import type { AuditRepository } from '../storage/AuditRepository';
import { CommandExecutor } from './CommandExecutor';
import { PolicyEngine } from './PolicyEngine';
import { planAction } from './CommandPlanner';
import type { CommandResult, DeviceIO, PlannedAction } from './types';
import {
    defaultLanguage as primaryLanguage,
    languageMessage,
    languageRules,
    supportedLanguages,
} from '../i18n/LanguageConfig';

const SYSTEM_ACTIONS: Record<string, ActionKind> = {
    'device.turnOn': 'turnOn',
    'device.turnOff': 'turnOff',
    'device.setLevel': 'setLevel',
    'device.setTemperature': 'setTemperature',
    'device.getState': 'getState',
    'device.getValue': 'getValue',
};

function isExplicitSetpointWrite(text: string, language: Language): boolean {
    const rules = languageRules(language);
    return new RegExp(rules.setpointVerb, 'iu').test(text) && new RegExp(rules.setpointTarget, 'iu').test(text);
}

function responseText(language: Language, key: string, values: Record<string, string> = {}): string {
    return languageMessage(language, key)
        .replace(/\{([a-z]+)\}/g, (_match, name: string) => values[name] ?? '')
        .replace(/\s+([.,!?])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function hasUnsupportedSyntax(
    text: string,
    language: Language,
    unsupported: string[],
    roomCount: number,
    action?: ActionKind,
): boolean {
    if (unsupported.some(kind => kind !== 'multipleActions')) {
        return true;
    }
    if (!unsupported.includes('multipleActions')) {
        return false;
    }
    const rules = languageRules(language);
    if ([...text.matchAll(new RegExp(rules.actionVerbs, 'giu'))].length > 1) {
        return true;
    }
    if (roomCount > 1) {
        return false;
    }
    if (!action) {
        return false;
    }
    return !(
        action === 'getValue' &&
        new RegExp(rules.valueDomainTemperature, 'iu').test(text) &&
        new RegExp(rules.valueDomainBrightness, 'iu').test(text)
    );
}

function planResponse(
    language: Language,
    plan: PlannedAction,
    phase: 'planned' | 'accepted' | 'confirmed',
    deviceName: string,
    roomName: string | undefined,
    resultValue?: boolean | number | string | null,
    requested?: { value: number; type: string },
): string {
    const context = roomName ? responseText(language, 'roomContext', { room: roomName }) : '';
    const value = phase === 'confirmed' ? resultValue : (requested?.value ?? plan.value);
    const formattedValue =
        typeof value === 'number' ? new Intl.NumberFormat(language).format(value) : String(value ?? '');
    const values = {
        device: deviceName,
        context,
        value: formattedValue,
        unit: requested?.type === 'percent' ? '%' : (plan.capability.unit ?? ''),
    };
    if (phase === 'confirmed') {
        if (value === null || value === undefined) {
            return responseText(language, 'confirmed.noValue', values);
        }
        if (plan.action === 'getState') {
            if (value === (plan.capability.mapping?.on ?? true)) {
                return responseText(language, 'confirmed.getState.on', values);
            }
            if (value === (plan.capability.mapping?.off ?? false)) {
                return responseText(language, 'confirmed.getState.off', values);
            }
            return responseText(language, 'confirmed.getState.other', values);
        }
    }
    return responseText(language, `${phase}.${plan.action}`, values);
}

interface CachedRequest {
    fingerprint: string;
    expiresAt: number;
    result: Promise<CommandResult>;
}

export class CommandController {
    private readonly sessions = new SessionStore();
    private readonly recent = new Map<string, CachedRequest>();

    public constructor(
        private readonly catalog: DeviceCatalogView,
        private readonly io: DeviceIO,
        private readonly getModel: () => { engine: NlpEngine; version?: string } | undefined,
        private readonly getUserIntents: () => IntentDefinition[],
        private readonly audit: AuditRepository,
        private readonly defaultLanguage: Language = primaryLanguage(),
    ) {}

    public process(request: CommandRequest, clientKey: string): Promise<CommandResult> {
        const key = `${clientKey}:${request.requestId}`;
        const fingerprint = JSON.stringify(request);
        const now = Date.now();
        for (const [id, cached] of this.recent) {
            if (cached.expiresAt <= now) {
                this.recent.delete(id);
            }
        }
        const existing = this.recent.get(key);
        if (existing) {
            if (existing.fingerprint !== fingerprint) {
                return Promise.resolve(
                    this.reject(request, request.language ?? this.defaultLanguage, 'DUPLICATE_REQUEST_ID'),
                );
            }
            return existing.result;
        }
        const result = this.run(request, clientKey);
        this.recent.set(key, { fingerprint, expiresAt: now + 5 * 60_000, result });
        if (this.recent.size > 1000) {
            this.recent.delete(this.recent.keys().next().value!);
        }
        return result;
    }

    private async run(request: CommandRequest, clientKey: string): Promise<CommandResult> {
        const started = Date.now();
        let language = request.language ?? this.defaultLanguage;
        let result: CommandResult;
        const details: NonNullable<CommandResult['analysis']> = {};
        try {
            result = await this.resolve(request, clientKey, language, details);
            language = result.language;
        } catch {
            result = {
                requestId: request.requestId,
                status: 'error',
                language,
                response: languageMessage(language, 'processingFailed'),
                errorCode: 'PROCESSING_ERROR',
            };
        }
        if (request.mode === 'analyze') {
            result.analysis = details;
        }
        result.durationMs = Date.now() - started;
        try {
            await this.audit.append({
                at: new Date().toISOString(),
                requestId: request.requestId,
                intent: result.intent,
                deviceId: result.actions?.[0]?.deviceId,
                decision: request.mode,
                result: result.status,
                errorCode: result.errorCode,
            });
        } catch {
            // Audit failure is reported by the adapter's diagnostics in a later phase.
        }
        return result;
    }

    private async resolve(
        request: CommandRequest,
        clientKey: string,
        language: Language,
        details: NonNullable<CommandResult['analysis']>,
    ): Promise<CommandResult> {
        const model = this.getModel();
        if (!model) {
            return this.reject(request, language, 'MODEL_UNAVAILABLE');
        }
        const rooms = [
            ...new Set(
                this.catalog
                    .list()
                    .filter(device => device.status !== 'missing')
                    .flatMap(device => device.roomIds.flatMap(id => roomNames(device, id, language)))
                    .filter(Boolean),
            ),
        ];
        const resolver = new DeviceResolver(this.catalog);
        let text = request.text;
        let forcedDeviceId: string | undefined;
        let forcedRoomId: string | undefined;
        let selectedStateId: string | undefined;
        let intent: string;
        let action: ActionKind;
        let confidence: number;
        if (request.clarificationId && request.selection) {
            const pending = this.sessions.consume(request.clarificationId, clientKey, request.sessionId);
            if (!pending || pending.request.mode !== request.mode) {
                return this.reject(request, language, 'CLARIFICATION_EXPIRED');
            }
            language = pending.language;
            intent = pending.intent;
            action = pending.action;
            confidence = pending.confidence;
            text = pending.key === 'value' ? `${pending.request.text} ${request.selection}` : pending.request.text;
            forcedRoomId = pending.selectedRoomId;
            if (pending.key === 'room') {
                if (!pending.roomIds?.includes(request.selection)) {
                    return this.reject(request, language, 'INVALID_SELECTION');
                }
                forcedRoomId = request.selection;
            }
            if (pending.key === 'device') {
                if (!pending.deviceIds.includes(request.selection)) {
                    return this.reject(request, language, 'INVALID_SELECTION');
                }
                forcedDeviceId = request.selection;
            } else if (pending.key === 'capability') {
                if (!pending.stateIds?.includes(request.selection)) {
                    return this.reject(request, language, 'INVALID_SELECTION');
                }
                forcedDeviceId = pending.selectedDeviceId;
                selectedStateId = request.selection;
            } else if (pending.key === 'value') {
                forcedDeviceId = pending.selectedDeviceId;
                selectedStateId = pending.stateIds?.[0];
            }
        } else {
            const parsed = parseEntities(text, language, rooms);
            const roomMatches = resolver.roomMatches(text, language);
            details.entities = parsed.entities;
            if (parsed.negated || hasUnsupportedSyntax(text, language, parsed.unsupported, roomMatches.length)) {
                return this.reject(request, language, 'UNSUPPORTED_SYNTAX');
            }
            if (
                !parsed.entities.some(entity => entity.type === 'room') &&
                new RegExp(languageRules(language).roomReference, 'iu').test(text)
            ) {
                return this.reject(request, language, 'UNKNOWN_ROOM');
            }
            const analysis = await model.engine.analyze(text, language);
            const explicitSetpointWrite = isExplicitSetpointWrite(text, language);
            intent = explicitSetpointWrite ? 'device.setTemperature' : (analysis.intent ?? '');
            confidence = explicitSetpointWrite ? 1 : analysis.confidence;
            details.alternatives = explicitSetpointWrite ? [{ intent, confidence }] : analysis.alternatives;
            const second = analysis.alternatives.find(item => item.intent !== intent)?.confidence ?? 0;
            if (!intent || (!explicitSetpointWrite && (confidence < 0.65 || confidence - second < 0.12))) {
                return this.reject(request, language, 'UNCLEAR_INTENT');
            }
            const configured = this.getUserIntents().find(item => item.id === intent && item.enabled);
            if (configured?.action?.kind === 'response') {
                const responses = configured.action.response;
                return {
                    requestId: request.requestId,
                    status: 'success',
                    language,
                    intent,
                    confidence,
                    response:
                        responses[language] ?? supportedLanguages.map(item => responses[item.code]).find(Boolean) ?? '',
                    modelVersion: model.version,
                };
            }
            action = configured?.action?.kind === 'capability' ? configured.action.operation : SYSTEM_ACTIONS[intent];
            if (!action) {
                return this.reject(request, language, 'UNSUPPORTED_ACTION');
            }
            if (roomMatches.length > 1) {
                const pending = this.sessions.create({
                    key: 'room',
                    clientKey,
                    sessionId: request.sessionId,
                    request,
                    language,
                    action,
                    intent,
                    confidence,
                    deviceIds: [],
                    roomIds: roomMatches.map(room => room.id),
                });
                return {
                    requestId: request.requestId,
                    status: 'clarification',
                    language,
                    intent,
                    confidence,
                    response: responseText(language, 'roomChoices', {
                        options: roomMatches.map(room => room.label).join(', '),
                    }),
                    clarification: { id: pending.id, key: 'room', options: roomMatches },
                    modelVersion: model.version,
                };
            }
        }
        const parsed = parseEntities(text, language, rooms);
        details.entities = parsed.entities;
        if (
            parsed.negated ||
            hasUnsupportedSyntax(
                text,
                language,
                parsed.unsupported,
                resolver.roomMatches(text, language).length,
                action,
            )
        ) {
            return this.reject(request, language, 'UNSUPPORTED_SYNTAX');
        }
        let deviceId = forcedDeviceId;
        let candidates;
        if (!deviceId) {
            const resolution = resolver.resolve(text, language, action, forcedRoomId);
            candidates = resolution.candidates;
            details.candidates = resolution.candidates;
            if (!resolution.candidates.length) {
                if (!forcedRoomId && !resolver.roomMatches(text, language).length) {
                    const domain = action === 'getValue' ? inferValueDomain(text, language) : undefined;
                    const eligible = this.catalog
                        .list()
                        .filter(device =>
                            device.discoveredCapabilities.some(
                                capability =>
                                    this.catalog.isAllowed(device.id, capability, action) &&
                                    matchesValueDomain(capability, domain),
                            ),
                        );
                    if (eligible.length) {
                        const options = eligible.map(device => {
                            const room = device.roomIds[0];
                            return {
                                id: device.id,
                                label: room
                                    ? `${device.displayName} (${roomNames(device, room, language).at(-1)})`
                                    : device.displayName,
                            };
                        });
                        const pending = this.sessions.create({
                            key: 'device',
                            clientKey,
                            sessionId: request.sessionId,
                            request,
                            language,
                            action,
                            intent,
                            confidence,
                            deviceIds: eligible.map(device => device.id),
                        });
                        return {
                            requestId: request.requestId,
                            status: 'clarification',
                            language,
                            intent,
                            confidence,
                            response: responseText(language, 'deviceChoices', {
                                options: options.map(item => item.label).join(', '),
                            }),
                            clarification: { id: pending.id, key: 'device', options },
                            modelVersion: model.version,
                        };
                    }
                }
                return this.reject(
                    request,
                    language,
                    'DEVICE_NOT_FOUND_OR_NOT_APPROVED',
                    intent,
                    confidence,
                    parsed.entities.some(entity => entity.type === 'room')
                        ? 'deviceNotFoundInRoom'
                        : 'error.DEVICE_NOT_FOUND_OR_NOT_APPROVED',
                );
            }
            if (!resolution.selected) {
                if (!forcedRoomId && !resolver.roomMatches(text, language).length) {
                    const roomOptions = new Map<string, string>();
                    for (const candidate of resolution.candidates) {
                        const device = this.catalog.list().find(item => item.id === candidate.deviceId);
                        for (const id of device?.roomIds ?? []) {
                            roomOptions.set(id, device ? (roomNames(device, id, language).at(-1) ?? id) : id);
                        }
                    }
                    if (roomOptions.size > 1) {
                        const options = [...roomOptions].map(([id, label]) => ({ id, label }));
                        const pending = this.sessions.create({
                            key: 'room',
                            clientKey,
                            sessionId: request.sessionId,
                            request,
                            language,
                            action,
                            intent,
                            confidence,
                            deviceIds: resolution.candidates.map(item => item.deviceId),
                            roomIds: options.map(item => item.id),
                        });
                        return {
                            requestId: request.requestId,
                            status: 'clarification',
                            language,
                            intent,
                            confidence,
                            response: responseText(language, 'roomChoices', {
                                options: options.map(item => item.label).join(', '),
                            }),
                            clarification: { id: pending.id, key: 'room', options },
                            modelVersion: model.version,
                        };
                    }
                }
                const options = resolution.candidates.map(item => {
                    const device = this.catalog.list().find(record => record.id === item.deviceId);
                    const room = device?.roomIds[0];
                    const label = device?.displayName ?? item.deviceId;
                    return {
                        id: item.deviceId,
                        label: room && device ? `${label} (${roomNames(device, room, language).at(-1)})` : label,
                    };
                });
                const pending = this.sessions.create({
                    key: 'device',
                    clientKey,
                    sessionId: request.sessionId,
                    request,
                    language,
                    action,
                    intent,
                    confidence,
                    deviceIds: resolution.candidates.map(item => item.deviceId),
                    selectedRoomId: forcedRoomId,
                });
                return {
                    requestId: request.requestId,
                    status: 'clarification',
                    language,
                    intent,
                    confidence,
                    response: responseText(language, 'deviceChoices', {
                        options: options.map(item => item.label).join(', '),
                    }),
                    candidates,
                    clarification: {
                        id: pending.id,
                        key: 'device',
                        options,
                    },
                    modelVersion: model.version,
                };
            }
            deviceId = resolution.selected.deviceId;
        }
        const outcome = planAction(
            this.catalog,
            deviceId,
            action,
            parsed,
            action === 'getValue' ? inferValueDomain(text, language) : undefined,
            selectedStateId,
        );
        if ('error' in outcome) {
            return this.reject(request, language, outcome.error, intent, confidence);
        }
        if ('clarification' in outcome) {
            if (outcome.clarification === 'capability') {
                const device = this.catalog.list().find(item => item.id === deviceId);
                const options = outcome.stateIds.map(id => {
                    const capability = device?.discoveredCapabilities.find(item => item.stateId === id);
                    const kind = capability ? languageMessage(language, `capability.${capability.kind}`) : id;
                    return { id, label: `${kind} (${id.split('.').at(-1)})` };
                });
                const pending = this.sessions.create({
                    key: 'capability',
                    clientKey,
                    sessionId: request.sessionId,
                    request,
                    language,
                    action,
                    intent,
                    confidence,
                    deviceIds: [deviceId],
                    selectedDeviceId: deviceId,
                    selectedRoomId: forcedRoomId,
                    stateIds: outcome.stateIds,
                });
                return {
                    requestId: request.requestId,
                    status: 'clarification',
                    language,
                    intent,
                    confidence,
                    response: responseText(language, 'capabilityChoices', {
                        options: options.map(item => item.label).join(', '),
                    }),
                    clarification: { id: pending.id, key: 'capability', options },
                    modelVersion: model.version,
                };
            }
            const pending = this.sessions.create({
                key: 'value',
                clientKey,
                sessionId: request.sessionId,
                request,
                language,
                action,
                intent,
                confidence,
                deviceIds: [deviceId],
                selectedDeviceId: deviceId,
                selectedRoomId: forcedRoomId,
                stateIds: selectedStateId ? [selectedStateId] : undefined,
            });
            return {
                requestId: request.requestId,
                status: 'clarification',
                language,
                intent,
                confidence,
                response: languageMessage(language, 'valueClarification'),
                clarification: { id: pending.id, key: 'value' },
                modelVersion: model.version,
            };
        }
        const plan = outcome.plan;
        details.plan = { action: plan.action, operation: plan.operation, stateId: plan.stateId, value: plan.value };
        const policy = new PolicyEngine(this.catalog, this.io);
        const decision = await policy.validate(plan);
        details.policyDecision = decision.allowed ? 'allowed' : decision.code;
        if (!decision.allowed) {
            return this.reject(request, language, decision.code, intent, confidence);
        }
        const device = this.catalog.list().find(item => item.id === deviceId);
        const roomId =
            forcedRoomId ??
            resolver.roomMatches(text, language).find(item => device?.roomIds.includes(item.id))?.id ??
            device?.roomIds[0];
        const roomName = roomId && device ? roomNames(device, roomId, language).at(-1) : undefined;
        const deviceName = device?.displayName ?? deviceId;
        const requestedEntity = parsed.entities.find(
            entity => entity.type === 'number' || entity.type === 'percent' || entity.type === 'temperature',
        );
        const requested =
            typeof requestedEntity?.value === 'number'
                ? { value: requestedEntity.value, type: requestedEntity.type }
                : undefined;
        if (request.mode === 'analyze') {
            return {
                requestId: request.requestId,
                status: 'success',
                language,
                intent,
                confidence,
                response: planResponse(language, plan, 'planned', deviceName, roomName, undefined, requested),
                actions: [{ deviceId, stateId: plan.stateId, status: 'planned' }],
                modelVersion: model.version,
            };
        }
        const executed = await new CommandExecutor(this.io, policy).execute(plan);
        return {
            requestId: request.requestId,
            status: executed.status === 'rejected' ? 'rejected' : executed.status === 'failed' ? 'error' : 'success',
            language,
            intent,
            confidence,
            response:
                executed.status === 'accepted'
                    ? planResponse(language, plan, 'accepted', deviceName, roomName, undefined, requested)
                    : executed.status === 'confirmed'
                      ? planResponse(language, plan, 'confirmed', deviceName, roomName, executed.value)
                      : languageMessage(language, `error.${executed.message ?? ''}`, 'executionFailed'),
            errorCode: executed.status === 'rejected' || executed.status === 'failed' ? executed.message : undefined,
            actions: [executed],
            modelVersion: model.version,
        };
    }

    private reject(
        request: CommandRequest,
        language: Language,
        code: string,
        intent?: string,
        confidence?: number,
        responseKey = `error.${code}`,
    ): CommandResult {
        return {
            requestId: request.requestId,
            status: 'rejected',
            language,
            intent,
            confidence,
            response: languageMessage(language, responseKey, 'rejected'),
            errorCode: code,
        };
    }
}
