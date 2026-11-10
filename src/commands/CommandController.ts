import type { CommandRequest, Language } from '../types/api';
import type { ActionKind } from '../devices/types';
import { DeviceResolver, type DeviceCatalogView } from '../devices/DeviceResolver';
import { parseEntities } from '../nlp/EntityParser';
import type { NlpEngine } from '../nlp/NlpEngine';
import type { IntentDefinition } from '../nlp/types';
import { SessionStore } from '../dialog/SessionStore';
import type { AuditRepository } from '../storage/AuditRepository';
import { CommandExecutor } from './CommandExecutor';
import { PolicyEngine } from './PolicyEngine';
import { planAction } from './CommandPlanner';
import type { CommandResult, DeviceIO } from './types';

const SYSTEM_ACTIONS: Record<string, ActionKind> = {
    'device.turnOn': 'turnOn',
    'device.turnOff': 'turnOff',
    'device.setLevel': 'setLevel',
    'device.setTemperature': 'setTemperature',
    'device.getState': 'getState',
    'device.getValue': 'getValue',
};

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
        private readonly defaultLanguage: Language = 'de',
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
                response: 'Processing failed',
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
        let text = request.text;
        let forcedDeviceId: string | undefined;
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
            if (pending.key === 'device') {
                if (!pending.deviceIds.includes(request.selection)) {
                    return this.reject(request, language, 'INVALID_SELECTION');
                }
                forcedDeviceId = request.selection;
            } else {
                forcedDeviceId = pending.selectedDeviceId;
            }
        } else {
            const parsed = parseEntities(text, language);
            details.entities = parsed.entities;
            if (parsed.negated || parsed.unsupported.length) {
                return this.reject(request, language, 'UNSUPPORTED_SYNTAX');
            }
            const analysis = await model.engine.analyze(text, language);
            details.alternatives = analysis.alternatives;
            intent = analysis.intent ?? '';
            confidence = analysis.confidence;
            const second = analysis.alternatives.find(item => item.intent !== intent)?.confidence ?? 0;
            if (!intent || confidence < 0.65 || confidence - second < 0.12) {
                return this.reject(request, language, 'UNCLEAR_INTENT');
            }
            const configured = this.getUserIntents().find(item => item.id === intent && item.enabled);
            if (configured?.action?.kind === 'response') {
                return {
                    requestId: request.requestId,
                    status: 'success',
                    language,
                    intent,
                    confidence,
                    response:
                        configured.action.response[language] ??
                        configured.action.response.de ??
                        configured.action.response.en ??
                        '',
                    modelVersion: model.version,
                };
            }
            action = configured?.action?.kind === 'capability' ? configured.action.operation : SYSTEM_ACTIONS[intent];
            if (!action) {
                return this.reject(request, language, 'UNSUPPORTED_ACTION');
            }
        }
        const parsed = parseEntities(text, language);
        details.entities = parsed.entities;
        if (parsed.negated || parsed.unsupported.length) {
            return this.reject(request, language, 'UNSUPPORTED_SYNTAX');
        }
        let deviceId = forcedDeviceId;
        let candidates;
        if (!deviceId) {
            const resolution = new DeviceResolver(this.catalog).resolve(text, language, action);
            candidates = resolution.candidates;
            details.candidates = resolution.candidates;
            if (!resolution.candidates.length) {
                return this.reject(request, language, 'DEVICE_NOT_FOUND_OR_NOT_APPROVED', intent, confidence);
            }
            if (!resolution.selected) {
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
                });
                return {
                    requestId: request.requestId,
                    status: 'clarification',
                    language,
                    intent,
                    confidence,
                    response: language === 'de' ? 'Welches Gerät meinst du?' : 'Which device do you mean?',
                    candidates,
                    clarification: {
                        id: pending.id,
                        key: 'device',
                        options: resolution.candidates.map(item => ({
                            id: item.deviceId,
                            label:
                                this.catalog.list().find(device => device.id === item.deviceId)?.displayName ??
                                item.deviceId,
                        })),
                    },
                    modelVersion: model.version,
                };
            }
            deviceId = resolution.selected.deviceId;
        }
        const outcome = planAction(this.catalog, deviceId, action, parsed);
        if ('error' in outcome) {
            return this.reject(request, language, outcome.error, intent, confidence);
        }
        if ('clarification' in outcome) {
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
            });
            return {
                requestId: request.requestId,
                status: 'clarification',
                language,
                intent,
                confidence,
                response: language === 'de' ? 'Welchen Wert soll ich setzen?' : 'Which value should I set?',
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
        if (request.mode === 'analyze') {
            return {
                requestId: request.requestId,
                status: 'success',
                language,
                intent,
                confidence,
                response: language === 'de' ? 'Aktion geplant.' : 'Action planned.',
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
                    ? language === 'de'
                        ? 'Befehl übergeben.'
                        : 'Command accepted.'
                    : executed.status === 'confirmed'
                      ? String(executed.value)
                      : (executed.message ?? 'Execution failed'),
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
    ): CommandResult {
        return {
            requestId: request.requestId,
            status: 'rejected',
            language,
            intent,
            confidence,
            response: language === 'de' ? 'Anfrage abgelehnt.' : 'Request rejected.',
            errorCode: code,
        };
    }
}
