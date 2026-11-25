import type { CommandRequest, Language } from '../types/api';
import type { ActionKind, Capability, DeviceRecord } from '../devices/types';
import { capabilityName, capabilityNameMatches } from '../devices/CapabilityName';
import { similarNameDistance } from '../devices/NameSimilarity';
import { DeviceResolver, roomNames } from '../devices/DeviceResolver';
import type { DeviceCatalogView } from '../devices/DeviceResolver';
import { inferValueDomain, matchesValueDomain } from '../devices/ValueDomain';
import type { ValueDomain } from '../devices/ValueDomain';
import { parseEntities, withoutDeviceNameNumbers } from '../nlp/EntityParser';
import type { NlpEngine } from '../nlp/NlpEngine';
import type { IntentDefinition, SendToIntentAction } from '../nlp/types';
import {
    extractParameters,
    fillPayload,
    hasClarificationPlaceholder,
    matchesSendToPattern,
    parseParameter,
} from '../nlp/SendToAction';
import type { SendToSelection } from '../nlp/SendToAction';
import { SessionStore } from '../dialog/SessionStore';
import type { PendingClarification } from '../dialog/SessionStore';
import type { AuditRepository } from '../storage/AuditRepository';
import { CommandExecutor } from './CommandExecutor';
import { PolicyEngine } from './PolicyEngine';
import { planAction } from './CommandPlanner';
import {
    enumRelativeTarget,
    parseRelativeRequest,
    profiles as defaultProfiles,
    relativeLanguageRules,
    relativeTarget,
} from './RelativeValue';
import type { RelativeProperty } from './RelativeValue';
import { colorValue, matchEffectiveColor, matchNamedTemperature } from './NamedColors';
import { adjustHexColor } from './ColorAdjust';
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
    'device.setLevel': 'setValue',
    'device.setTemperature': 'setValue',
    'device.setValue': 'setValue',
    'device.press': 'press',
    'device.getState': 'getState',
    'device.getValue': 'getValue',
};

const CATALOG_INTENTS = new Set(['device.listRooms', 'device.listDevices', 'device.listFunctions']);
const CAPABILITY_ACTIONS: ActionKind[] = ['turnOn', 'turnOff', 'setValue', 'press', 'getState', 'getValue'];

function isExplicitSetpointWrite(text: string, language: Language): boolean {
    const rules = languageRules(language);
    return new RegExp(rules.setpointVerb, 'iu').test(text) && new RegExp(rules.setpointTarget, 'iu').test(text);
}

function matchStringPhrase(
    text: string,
    examples: string[],
    language: Language,
): { prefix: string; value?: string } | undefined {
    const request = text.trim();
    for (const prefix of examples.map(example => example.trim()).sort((a, b) => b.length - a.length)) {
        const remainder = request.slice(prefix.length);
        if (
            prefix &&
            request.slice(0, prefix.length).toLocaleLowerCase(language) === prefix.toLocaleLowerCase(language)
        ) {
            if (!remainder) {
                return { prefix };
            }
            if (/^\s/.test(remainder) && remainder.trim()) {
                return { prefix, value: remainder.trim() };
            }
        }
    }
    return undefined;
}

function matchingStringIntent(
    text: string,
    language: Language,
    intents: IntentDefinition[],
): { intent: string; prefix: string; value?: string } | undefined {
    const matches = intents
        .filter(
            intent => intent.enabled && intent.action?.kind === 'capability' && intent.action.operation === 'setValue',
        )
        .flatMap(intent => {
            const match = matchStringPhrase(text, intent.utterances[language] ?? [], language);
            return match ? [{ intent: intent.id, ...match }] : [];
        })
        .sort((a, b) => b.prefix.length - a.prefix.length);
    return matches[0] && (!matches[1] || matches[0].prefix.length > matches[1].prefix.length) ? matches[0] : undefined;
}

function isExplicitNamedValueWrite(
    text: string,
    language: Language,
    catalog: DeviceCatalogView,
    resolver: DeviceResolver,
): boolean {
    if (!new RegExp(languageRules(language).setpointVerb, 'iu').test(text)) {
        return false;
    }
    const domain = inferValueDomain(text, language);
    const rooms = new Set(resolver.roomMatches(text, language).map(room => room.id));
    const named = catalog
        .list()
        .flatMap(device =>
            device.status === 'missing' || (rooms.size && !device.roomIds.some(id => rooms.has(id)))
                ? []
                : device.discoveredCapabilities.filter(
                      capability =>
                          catalog.isAllowed(device.id, capability, 'setValue') &&
                          matchesValueDomain(capability, domain, language) &&
                          capabilityNameMatches(capability, text, language),
                  ),
        );
    return named.length > 0;
}

function requestedDomain(
    intent: string,
    action: ActionKind,
    text: string,
    language: Language,
): ValueDomain | undefined {
    if (intent === 'device.setLevel') {
        return 'brightness';
    }
    if (intent === 'device.setTemperature') {
        return 'temperature';
    }
    return action === 'getValue' || action === 'setValue' ? inferValueDomain(text, language) : undefined;
}

function isExplicitButtonPress(text: string, language: Language, catalog: DeviceCatalogView): boolean {
    const rules = languageRules(language);
    const resolver = new DeviceResolver(catalog);
    const namedCandidate = (action: ActionKind): boolean =>
        resolver
            .resolve(text, language, action)
            .candidates.some(candidate =>
                candidate.reasons.some(reason => reason === 'exact name or alias' || reason === 'fuzzy name'),
            );
    return (
        new RegExp(rules.buttonPressVerb, 'iu').test(text) ||
        (new RegExp(rules.buttonSwitchVerb, 'iu').test(text) &&
            !new RegExp(rules.buttonStateQualifier, 'iu').test(text) &&
            namedCandidate('press') &&
            !namedCandidate('turnOn')) ||
        (new RegExp(rules.buttonActivationVerb, 'iu').test(text) &&
            (new RegExp(rules.buttonTarget, 'iu').test(text) ||
                catalog
                    .list()
                    .some(device =>
                        device.discoveredCapabilities.some(
                            capability =>
                                capability.kind === 'button' && capabilityNameMatches(capability, text, language),
                        ),
                    ) ||
                namedCandidate('press')))
    );
}

function responseText(language: Language, key: string, values: Record<string, string> = {}): string {
    return languageMessage(language, key)
        .replace(/\{([a-z]+)\}/g, (_match, name: string) => values[name] ?? '')
        .replace(/\s+([.,!?])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function capabilityLabel(language: Language, capability: Capability): string {
    return capabilityName(capability, language);
}

function normalizeReply(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function namedColorDevices(text: string, language: Language, catalog: DeviceCatalogView): DeviceRecord[] {
    const request = ` ${normalizeReply(text)} `;
    return catalog
        .list()
        .filter(
            device =>
                device.status !== 'missing' &&
                device.discoveredCapabilities.some(capability => capability.role?.startsWith('level.color.')) &&
                [device.displayName, ...(device.aliases[language] ?? [])].some(
                    name => name.trim() && request.includes(` ${normalizeReply(name)} `),
                ),
        );
}

function colorValuePhrase(phrase: string, devices: DeviceRecord[], language: Language): string {
    const normalized = normalizeReply(phrase);
    const labels = devices
        .flatMap(device =>
            device.discoveredCapabilities
                .filter(capability => capability.role?.startsWith('level.color.'))
                .map(capability => capabilityName(capability, language)),
        )
        .sort((a, b) => b.length - a.length);
    const label = labels.find(name => normalized.startsWith(`${normalizeReply(name)} `));
    return label ? phrase.trim().split(/\s+/).slice(label.trim().split(/\s+/).length).join(' ') : phrase.trim();
}

function relativePropertyForCapability(
    capability: Capability,
    requested?: RelativeProperty,
): RelativeProperty | undefined {
    if (capability.kind !== 'genericValue' || capability.valueKind !== 'number') {
        return undefined;
    }
    const role = capability.role ?? '';
    if (role === 'level.color.temperature' && capability.unit === 'K') {
        return 'colorTemperature';
    }
    if (
        (role === 'value.temperature' || role === 'level.temperature') &&
        (capability.unit === '°C' || capability.unit === '°F')
    ) {
        return 'temperature';
    }
    if (role === 'level.blind') {
        return 'position';
    }
    if (role === 'level.tilt') {
        return 'tilt';
    }
    if (role === 'level.volume' || role === 'value.volume') {
        return 'volume';
    }
    if (role === 'level.humidity' && capability.unit === '%') {
        return 'humidity';
    }
    if (role === 'level.color.saturation') {
        return 'saturation';
    }
    if (role === 'level.brightness' || role === 'value.brightness') {
        return 'brightness';
    }
    if (role === 'value.humidity' && capability.unit === '%' && requested === 'humidity') {
        return requested;
    }
    if (role === 'level' && requested === 'fanSpeed' && (capability.enumValues?.length ?? 0) > 1) {
        return requested;
    }
    if (
        role === 'level' &&
        capability.unit === '%' &&
        requested &&
        requested !== 'temperature' &&
        requested !== 'colorTemperature'
    ) {
        return requested;
    }
    return undefined;
}

function diagnosticSnapshot(value: unknown): unknown {
    try {
        const seen = new WeakSet<object>();
        const serialized = JSON.stringify(value, (_key, item: unknown) => {
            if (item instanceof Error) {
                return { name: item.name, message: item.message };
            }
            if (typeof item === 'bigint') {
                return String(item);
            }
            if (item && typeof item === 'object') {
                if (seen.has(item)) {
                    return '[Circular]';
                }
                seen.add(item);
            }
            return item;
        });
        if (serialized === undefined) {
            return String(value);
        }
        if (serialized.length > 8_192) {
            return { truncated: true, preview: serialized.slice(0, 8_192) };
        }
        return JSON.parse(serialized) as unknown;
    } catch {
        return { serializationError: String(value).slice(0, 500) };
    }
}

function matchingOptionIds(reply: string, options: Array<{ id: string; label: string }>, language: Language): string[] {
    if (options.length === 1 && isConfirmation(reply, language)) {
        return [options[0].id];
    }
    const normalized = normalizeReply(reply);
    return options
        .filter(option => normalized === normalizeReply(option.id) || normalized === normalizeReply(option.label))
        .map(option => option.id);
}

function isCancellation(text: string, language: Language): boolean {
    const normalized = normalizeReply(text);
    return languageRules(language).cancelPhrases.some(phrase => normalizeReply(phrase) === normalized);
}

function isConfirmation(text: string, language: Language): boolean {
    const normalized = normalizeReply(text);
    return languageRules(language).confirmationPhrases.some(phrase => normalizeReply(phrase) === normalized);
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
        function: capabilityLabel(language, plan.capability),
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
    private readonly recent = new Map<string, CachedRequest>();
    private readonly relativeQueues = new Map<string, Promise<void>>();

    public constructor(
        private readonly catalog: DeviceCatalogView,
        private readonly io: DeviceIO,
        private readonly getModel: () => { engine: NlpEngine; version?: string } | undefined,
        private readonly getUserIntents: () => IntentDefinition[],
        private readonly audit: AuditRepository,
        private readonly defaultLanguage: Language = primaryLanguage(),
        private readonly sessions = new SessionStore(),
        private readonly sendOutbound?: (instance: string, command: string, payload: unknown) => Promise<unknown>,
        private readonly reportError?: (error: unknown, requestId: string) => void,
    ) {}

    public process(
        request: CommandRequest,
        clientKey: string,
        includeExecutionDiagnostics = false,
    ): Promise<CommandResult> {
        const key = `${clientKey}:${request.requestId}`;
        const fingerprint = JSON.stringify({ request, includeExecutionDiagnostics });
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
        const result = this.run(request, clientKey, includeExecutionDiagnostics);
        this.recent.set(key, { fingerprint, expiresAt: now + 5 * 60_000, result });
        if (this.recent.size > 1000) {
            this.recent.delete(this.recent.keys().next().value!);
        }
        return result;
    }

    private async run(
        request: CommandRequest,
        clientKey: string,
        includeExecutionDiagnostics: boolean,
    ): Promise<CommandResult> {
        const started = Date.now();
        let language = request.language ?? this.defaultLanguage;
        let result: CommandResult;
        const details: NonNullable<CommandResult['analysis']> = {};
        try {
            result = await this.resolve(request, clientKey, language, details);
            language = result.language;
        } catch (error) {
            this.reportError?.(error, request.requestId);
            result = {
                requestId: request.requestId,
                status: 'error',
                language,
                response: languageMessage(language, 'processingFailed'),
                errorCode: 'PROCESSING_ERROR',
            };
        }
        if (request.mode === 'analyze' || includeExecutionDiagnostics) {
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
        if (!request.clarificationId) {
            this.sessions.clear(clientKey, request.sessionId);
        }
        const model = this.getModel();
        if (!model) {
            return this.reject(request, language, 'MODEL_UNAVAILABLE');
        }
        const userIntents = this.getUserIntents();
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
        let sourceRequest = request;
        let forcedDeviceId: string | undefined;
        let forcedRoomId: string | undefined;
        let selectedStateId: string | undefined;
        let intent: string;
        let action: ActionKind;
        let confidence: number;
        let clarifiedStringValue: string | undefined;
        if (request.clarificationId) {
            const pending = this.sessions.get(request.clarificationId, clientKey, request.sessionId);
            if (!pending || pending.request.mode !== request.mode) {
                return this.reject(request, language, 'CLARIFICATION_EXPIRED');
            }
            language = pending.language;
            if (isCancellation(request.text, language)) {
                this.sessions.consume(pending.id, clientKey, request.sessionId);
                return {
                    requestId: request.requestId,
                    status: 'cancelled',
                    language,
                    response: languageMessage(language, 'clarificationCancelled'),
                };
            }
            if (pending.key === 'colorName' && !request.selection) {
                const rules = relativeLanguageRules(language);
                if (
                    new RegExp(rules.colorSet, 'iu').test(request.text) &&
                    new RegExp(rules.colorVerb, 'iu').test(request.text)
                ) {
                    this.sessions.consume(pending.id, clientKey, request.sessionId);
                    return this.resolve({ ...request, clarificationId: undefined }, clientKey, language, details);
                }
            }
            if (pending.key === 'relativeDevice') {
                const options = pending.options ?? [];
                const answer = request.selection ?? request.text;
                const ids = matchingOptionIds(answer, options, language);
                if (ids.length !== 1) {
                    return this.repeatClarification(request, pending, model.version);
                }
                this.sessions.consume(pending.id, clientKey, request.sessionId);
                return this.processRelative(
                    { ...pending.request, requestId: request.requestId },
                    clientKey,
                    language,
                    resolver,
                    details,
                    model.version,
                    ids[0],
                );
            }
            if (pending.key === 'relativeCapability') {
                const ids = matchingOptionIds(request.selection ?? request.text, pending.options ?? [], language);
                if (ids.length !== 1 || !pending.selectedDeviceId) {
                    return this.repeatClarification(request, pending, model.version);
                }
                this.sessions.consume(pending.id, clientKey, request.sessionId);
                return this.processRelative(
                    { ...pending.request, requestId: request.requestId },
                    clientKey,
                    language,
                    resolver,
                    details,
                    model.version,
                    pending.selectedDeviceId,
                    ids[0],
                );
            }
            if (pending.key === 'colorName' || pending.key === 'colorDevice') {
                const rules = relativeLanguageRules(language);
                const originalPhrase = new RegExp(rules.colorSet, 'iu').exec(pending.request.text)?.[1];
                const answer = request.selection ?? request.text;
                const colorText =
                    pending.key === 'colorName'
                        ? answer
                        : originalPhrase
                          ? colorValuePhrase(
                                originalPhrase,
                                namedColorDevices(pending.request.text, language, this.catalog),
                                language,
                            )
                          : undefined;
                const named = colorText
                    ? (matchNamedTemperature(colorText, language) ??
                      matchEffectiveColor(colorText, language, this.catalog.getCustomColors?.()))
                    : undefined;
                if (!named || normalizeReply(colorText!) !== normalizeReply(named.name)) {
                    return this.repeatClarification(request, pending, model.version);
                }
                let deviceId: string | undefined;
                if (pending.key === 'colorDevice') {
                    const ids = matchingOptionIds(answer, pending.options ?? [], language);
                    if (ids.length !== 1) {
                        return this.repeatClarification(request, pending, model.version);
                    }
                    deviceId = ids[0];
                }
                this.sessions.consume(pending.id, clientKey, request.sessionId);
                const color =
                    'kelvin' in named
                        ? { kelvin: named.kelvin, name: named.name }
                        : { hex: named.hex, name: named.name };
                const source =
                    pending.key === 'colorName' && originalPhrase
                        ? {
                              ...pending.request,
                              text: pending.request.text.replace(originalPhrase, named.name),
                              requestId: request.requestId,
                          }
                        : { ...pending.request, requestId: request.requestId };
                return this.processNamedColor(
                    source,
                    clientKey,
                    language,
                    resolver,
                    color,
                    details,
                    model.version,
                    deviceId,
                );
            }
            if (pending.key === 'mediaDevice') {
                const ids = matchingOptionIds(request.selection ?? request.text, pending.options ?? [], language);
                if (ids.length !== 1) {
                    return this.repeatClarification(request, pending, model.version);
                }
                this.sessions.consume(pending.id, clientKey, request.sessionId);
                return this.processMedia(
                    { ...pending.request, requestId: request.requestId },
                    clientKey,
                    language,
                    resolver,
                    details,
                    model.version,
                    ids[0],
                );
            }
            if (pending.key === 'parameter') {
                const configured = userIntents.find(item => item.id === pending.intent && item.enabled);
                if (configured?.action?.kind !== 'sendTo') {
                    return this.reject(request, language, 'UNSUPPORTED_ACTION');
                }
                const parameter = configured.action.parameters.find(item => item.name === pending.parameterName);
                if (!parameter) {
                    return this.reject(request, language, 'UNSUPPORTED_ACTION');
                }
                const value = parseParameter(
                    request.text,
                    parameter.type,
                    language,
                    languageRules(language).spokenNumbers,
                );
                if (value === undefined) {
                    return this.repeatClarification(request, pending, model.version);
                }
                this.sessions.consume(pending.id, clientKey, request.sessionId);
                return this.processSendTo(
                    request,
                    clientKey,
                    language,
                    configured.action,
                    pending.intent,
                    pending.confidence,
                    model.version,
                    { ...pending.parameterValues, [parameter.name]: value },
                    details,
                );
            }
            if (pending.key === 'sendToOption') {
                const configured = userIntents.find(item => item.id === pending.intent && item.enabled);
                if (configured?.action?.kind !== 'sendTo') {
                    return this.reject(request, language, 'UNSUPPORTED_ACTION');
                }
                const answer = request.selection ?? request.text;
                let ids = matchingOptionIds(answer, pending.options ?? [], language);
                if (!ids.length) {
                    const spokenNumber = parseParameter(
                        answer,
                        'number',
                        language,
                        languageRules(language).spokenNumbers,
                    );
                    if (typeof spokenNumber === 'number' && Number.isInteger(spokenNumber)) {
                        ids = matchingOptionIds(String(spokenNumber), pending.options ?? [], language);
                    }
                }
                const selectedId = ids.length === 1 ? ids[0] : undefined;
                const selectedValue = selectedId ? pending.optionValues?.[selectedId] : undefined;
                const selectedOption = pending.options?.find(option => option.id === selectedId);
                if (selectedValue === undefined || !selectedOption) {
                    return this.repeatClarification(request, pending, model.version);
                }
                this.sessions.consume(pending.id, clientKey, request.sessionId);
                return this.processSendTo(
                    request,
                    clientKey,
                    language,
                    configured.action,
                    pending.intent,
                    pending.confidence,
                    model.version,
                    pending.parameterValues ?? {},
                    details,
                    { id: selectedOption.id, label: selectedOption.label, value: selectedValue, answer: request.text },
                );
            }
            if (pending.key === 'action') {
                const answer = normalizeReply(request.selection ?? request.text);
                const chosenAction = [
                    'turnon',
                    ...languageRules(language).actionOnAnswers.map(normalizeReply),
                ].includes(answer)
                    ? 'turnOn'
                    : ['turnoff', ...languageRules(language).actionOffAnswers.map(normalizeReply)].includes(answer)
                      ? 'turnOff'
                      : undefined;
                if (!chosenAction) {
                    return this.repeatClarification(request, pending, model.version);
                }
                this.sessions.consume(pending.id, clientKey, request.sessionId);
                action = chosenAction;
                intent = chosenAction === 'turnOn' ? 'device.turnOn' : 'device.turnOff';
                confidence = 1;
                text = `${pending.request.text} ${languageMessage(language, chosenAction === 'turnOn' ? 'actionOnLabel' : 'actionOffLabel')}`;
                sourceRequest = { ...pending.request, text };
            } else {
                intent = pending.intent;
                action = pending.action as ActionKind;
                confidence = pending.confidence;
                text = pending.request.text;
                sourceRequest = pending.request;
                forcedRoomId = pending.selectedRoomId;
                const answer = request.selection ?? request.text;
                if (pending.key === 'room') {
                    const matches = request.selection
                        ? (pending.roomIds?.filter(id => id === request.selection) ?? [])
                        : [
                              ...new Set([
                                  ...matchingOptionIds(answer, pending.options ?? [], language),
                                  ...resolver.roomMatches(answer, language).map(room => room.id),
                              ]),
                          ].filter(id => pending.roomIds?.includes(id));
                    if (matches.length !== 1) {
                        return this.repeatClarification(request, pending, model.version);
                    }
                    forcedRoomId = matches[0];
                }
                if (pending.key === 'device') {
                    const devices = this.catalog.list().filter(device => pending.deviceIds.includes(device.id));
                    const normalized = normalizeReply(answer);
                    const named = request.selection
                        ? devices.filter(device => device.id === request.selection)
                        : devices.filter(
                              device =>
                                  matchingOptionIds(answer, pending.options ?? [], language).includes(device.id) ||
                                  [device.displayName, ...(device.aliases[language] ?? [])].some(
                                      name => normalizeReply(name) === normalized,
                                  ),
                          );
                    const rooms = request.selection
                        ? []
                        : resolver
                              .roomMatches(answer, language)
                              .map(room => room.id)
                              .filter(id => devices.some(device => device.roomIds.includes(id)));
                    const matchingDevices = rooms.length
                        ? (named.length ? named : devices).filter(device =>
                              device.roomIds.some(id => rooms.includes(id)),
                          )
                        : named;
                    if (matchingDevices.length === 1) {
                        forcedDeviceId = matchingDevices[0].id;
                        forcedRoomId = rooms[0] ?? forcedRoomId;
                    } else if (rooms.length === 1 && matchingDevices.length > 1) {
                        forcedRoomId = rooms[0];
                    } else {
                        return this.repeatClarification(request, pending, model.version);
                    }
                } else if (pending.key === 'capability') {
                    const device = this.catalog.list().find(item => item.id === pending.selectedDeviceId);
                    const matches = request.selection
                        ? (pending.stateIds?.filter(id => id === request.selection) ?? [])
                        : [
                              ...new Set([
                                  ...matchingOptionIds(answer, pending.options ?? [], language),
                                  ...(device?.discoveredCapabilities
                                      .filter(
                                          capability =>
                                              pending.stateIds?.includes(capability.stateId) &&
                                              [
                                                  capabilityLabel(language, capability),
                                                  capability.stateId.split('.').at(-1) ?? '',
                                              ].some(label => normalizeReply(label) === normalizeReply(answer)),
                                      )
                                      .map(capability => capability.stateId) ?? []),
                              ]),
                          ];
                    if (matches.length !== 1) {
                        return this.repeatClarification(request, pending, model.version);
                    }
                    forcedDeviceId = pending.selectedDeviceId;
                    selectedStateId = matches[0];
                } else if (pending.key === 'value') {
                    const parsedAnswer = parseEntities(answer, language, rooms);
                    const stringTarget = this.catalog
                        .list()
                        .find(device => device.id === pending.selectedDeviceId)
                        ?.discoveredCapabilities.some(
                            capability =>
                                pending.stateIds?.includes(capability.stateId) && capability.valueKind === 'string',
                        );
                    if (
                        stringTarget
                            ? !answer.trim()
                            : !parsedAnswer.entities.some(entity =>
                                  ['number', 'percent', 'temperature'].includes(entity.type),
                              )
                    ) {
                        return this.repeatClarification(request, pending, model.version);
                    }
                    clarifiedStringValue = stringTarget ? answer.trim() : undefined;
                    forcedDeviceId = pending.selectedDeviceId;
                    selectedStateId = pending.stateIds?.[0];
                    text = `${pending.request.text} ${answer}`;
                }
            }
            this.sessions.consume(pending.id, clientKey, request.sessionId);
            if (CATALOG_INTENTS.has(intent)) {
                return this.catalogAnswer(
                    request,
                    clientKey,
                    language,
                    intent,
                    confidence,
                    model.version,
                    text,
                    forcedRoomId,
                    forcedDeviceId,
                );
            }
        } else {
            const parsed = parseEntities(text, language, rooms);
            const roomMatches = resolver.roomMatches(text, language);
            details.entities = parsed.entities;
            const relativeRequest = parseRelativeRequest(text, language);
            const unsupported = relativeRequest?.explicitAmount
                ? parsed.unsupported.filter(item => item !== 'unit')
                : parsed.unsupported;
            if (parsed.negated || hasUnsupportedSyntax(text, language, unsupported, roomMatches.length)) {
                return this.reject(request, language, 'UNSUPPORTED_SYNTAX');
            }
            if (!new RegExp(languageRules(language).buttonPressVerb, 'iu').test(text) && relativeRequest) {
                return this.processRelative(request, clientKey, language, resolver, details, model.version);
            }
            const colorRules = relativeLanguageRules(language);
            const normalizedMedia = normalizeReply(text);
            const nextMedia = new RegExp(colorRules.mediaNext, 'iu').test(normalizedMedia);
            const previousMedia = new RegExp(colorRules.mediaPrevious, 'iu').test(normalizedMedia);
            if (
                nextMedia !== previousMedia &&
                this.catalog
                    .list()
                    .some(device =>
                        device.discoveredCapabilities.some(
                            capability =>
                                capability.role === (nextMedia ? 'button.next' : 'button.previous') &&
                                this.catalog.isAllowed(device.id, capability, 'press'),
                        ),
                    )
            ) {
                return this.processMedia(request, clientKey, language, resolver, details, model.version);
            }
            const colorPhrase = new RegExp(colorRules.colorSet, 'iu').exec(text)?.[1];
            const colorDevices = namedColorDevices(text, language, this.catalog);
            const valuePhrase = colorPhrase ? colorValuePhrase(colorPhrase, colorDevices, language) : undefined;
            const namedColor = valuePhrase
                ? matchEffectiveColor(valuePhrase, language, this.catalog.getCustomColors?.())
                : undefined;
            const namedTemperature = valuePhrase ? matchNamedTemperature(valuePhrase, language) : undefined;
            const colorCommand = !!colorPhrase && new RegExp(colorRules.colorVerb, 'iu').test(text);
            if (
                colorCommand &&
                colorDevices.length === 1 &&
                roomMatches.length === 1 &&
                !colorDevices[0].roomIds.includes(roomMatches[0].id)
            ) {
                if (request.mode === 'analyze') {
                    const diagnostics = resolver.diagnose(text, language, 'setValue');
                    details.devices = diagnostics.devices;
                    details.functions = diagnostics.functions;
                    details.dataPoints = diagnostics.dataPoints;
                }
                const device = colorDevices[0];
                const actualRoom = device.roomIds[0] ? roomNames(device, device.roomIds[0], language).at(-1) : '';
                return {
                    requestId: request.requestId,
                    status: 'rejected',
                    language,
                    intent: 'device.setColor',
                    confidence: 1,
                    errorCode: 'DEVICE_ROOM_MISMATCH',
                    response: responseText(language, 'deviceRoomMismatch', {
                        device: device.displayName.trim(),
                        room: actualRoom ?? '',
                        requested: roomMatches[0].label,
                    }),
                    modelVersion: model.version,
                    analysis: request.mode === 'analyze' ? details : undefined,
                };
            }
            if (
                colorCommand &&
                valuePhrase &&
                (namedColor || namedTemperature) &&
                normalizeReply(valuePhrase) === normalizeReply((namedTemperature || namedColor)!.name)
            ) {
                return this.processNamedColor(
                    request,
                    clientKey,
                    language,
                    resolver,
                    namedTemperature
                        ? { kelvin: namedTemperature.kelvin, name: namedTemperature.name }
                        : { hex: namedColor!.hex, name: namedColor!.name },
                    details,
                    model.version,
                );
            }
            if (
                colorCommand &&
                valuePhrase &&
                !namedColor &&
                !namedTemperature &&
                /^[\p{L}\s-]+$/u.test(valuePhrase) &&
                colorDevices.length === 1
            ) {
                const device = colorDevices[0];
                if (
                    !device.discoveredCapabilities.some(
                        capability =>
                            capability.role?.startsWith('level.color.') &&
                            this.catalog.isAllowed(device.id, capability, 'setValue'),
                    )
                ) {
                    if (request.mode === 'analyze') {
                        const diagnostics = resolver.diagnose(text, language, 'setValue');
                        details.devices = diagnostics.devices;
                        details.functions = diagnostics.functions;
                        details.dataPoints = diagnostics.dataPoints;
                    }
                    return {
                        ...this.reject(request, language, 'ACTION_NOT_APPROVED', 'device.setColor', 1),
                        analysis: request.mode === 'analyze' ? details : undefined,
                    };
                }
                const question = languageMessage(language, 'colorNameQuestion');
                const pending = this.sessions.create({
                    key: 'colorName',
                    clientKey,
                    sessionId: request.sessionId,
                    request,
                    language,
                    action: 'setValue',
                    intent: 'device.setColor',
                    confidence: 1,
                    deviceIds: [],
                    question,
                });
                return {
                    requestId: request.requestId,
                    status: 'clarification',
                    language,
                    intent: 'device.setColor',
                    confidence: 1,
                    response: question,
                    clarification: { id: pending.id, key: 'colorName' },
                    modelVersion: model.version,
                };
            }
            const analysis = await model.engine.analyze(text, language);
            const explicitSetpointWrite = isExplicitSetpointWrite(text, language);
            const explicitButtonPress = isExplicitButtonPress(text, language, this.catalog);
            const secondBest = analysis.alternatives.find(item => item.intent !== analysis.intent)?.confidence ?? 0;
            const uncertainIntent =
                !analysis.intent || analysis.confidence < 0.65 || analysis.confidence - secondBest < 0.12;
            const stringIntentMatch = matchingStringIntent(text, language, userIntents);
            const sendToMatches = userIntents.filter(
                item =>
                    item.enabled &&
                    item.action?.kind === 'sendTo' &&
                    (matchesSendToPattern(item.action, text, language) ||
                        (item.utterances[language] ?? []).some(example => {
                            const phrase = example.trim().toLocaleLowerCase(language);
                            const requestText = text.trim().toLocaleLowerCase(language);
                            return requestText === phrase || requestText.startsWith(`${phrase} `);
                        })),
            );
            const explicitSendToIntent = sendToMatches.length === 1 ? sendToMatches[0].id : undefined;
            const explicitStringIntent =
                stringIntentMatch !== undefined && analysis.intent === stringIntentMatch.intent;
            const explicitNamedValueWrite =
                !explicitSetpointWrite &&
                !explicitButtonPress &&
                !explicitStringIntent &&
                (uncertainIntent || analysis.intent?.startsWith('device.')) &&
                isExplicitNamedValueWrite(text, language, this.catalog, resolver);
            intent = explicitSendToIntent
                ? explicitSendToIntent
                : explicitButtonPress
                  ? 'device.press'
                  : explicitSetpointWrite
                    ? 'device.setTemperature'
                    : explicitStringIntent
                      ? stringIntentMatch.intent
                      : explicitNamedValueWrite
                        ? 'device.setValue'
                        : (analysis.intent ?? '');
            confidence = explicitSendToIntent || explicitButtonPress || explicitSetpointWrite ? 1 : analysis.confidence;
            details.alternatives =
                explicitSendToIntent || explicitButtonPress || explicitSetpointWrite
                    ? [{ intent, confidence }]
                    : analysis.alternatives;
            if (
                (intent === 'device.turnOn' || intent === 'device.turnOff') &&
                !explicitSendToIntent &&
                !explicitStringIntent &&
                !explicitButtonPress &&
                !explicitSetpointWrite &&
                !explicitNamedValueWrite &&
                new RegExp(languageRules(language).buttonSwitchVerb, 'iu').test(text) &&
                !new RegExp(languageRules(language).buttonStateQualifier, 'iu').test(text) &&
                (resolver.resolve(text, language, 'turnOn').candidates.length > 0 ||
                    resolver.resolve(text, language, 'turnOff').candidates.length > 0)
            ) {
                const device = new RegExp(languageRules(language).deviceBeforeRoom, 'iu').exec(text)?.groups?.device;
                const question = responseText(language, 'actionChoices', {
                    device: device
                        ? responseText(language, 'actionQuotedDevice', { device: device.trim() })
                        : languageMessage(language, 'actionDeviceGeneric'),
                });
                const options = [
                    { id: 'turnOn', label: languageMessage(language, 'actionOnLabel') },
                    { id: 'turnOff', label: languageMessage(language, 'actionOffLabel') },
                ];
                if (request.mode === 'analyze') {
                    const diagnostics = resolver.diagnose(text, language, SYSTEM_ACTIONS[intent]);
                    details.devices = diagnostics.devices;
                    details.functions = diagnostics.functions;
                    details.dataPoints = diagnostics.dataPoints;
                }
                const pending = this.sessions.create({
                    key: 'action',
                    clientKey,
                    sessionId: request.sessionId,
                    request: sourceRequest,
                    language,
                    action: 'turnOn',
                    intent,
                    confidence,
                    deviceIds: [],
                    options,
                    question,
                });
                return {
                    requestId: request.requestId,
                    status: 'clarification',
                    language,
                    response: question,
                    clarification: { id: pending.id, key: 'action', options },
                    modelVersion: model.version,
                };
            }
            const second = analysis.alternatives.find(item => item.intent !== intent)?.confidence ?? 0;
            if (
                !intent ||
                (!explicitButtonPress &&
                    !explicitSetpointWrite &&
                    !explicitSendToIntent &&
                    !explicitStringIntent &&
                    !explicitNamedValueWrite &&
                    (confidence < 0.65 || confidence - second < 0.12))
            ) {
                const tentativeAction = SYSTEM_ACTIONS[intent];
                if (request.mode === 'analyze' && tentativeAction) {
                    const diagnostics = resolver.diagnose(
                        text,
                        language,
                        tentativeAction,
                        undefined,
                        requestedDomain(intent, tentativeAction, text, language),
                    );
                    details.devices = diagnostics.devices;
                    details.functions = diagnostics.functions;
                    details.dataPoints = diagnostics.dataPoints;
                }
                return this.reject(request, language, 'UNCLEAR_INTENT');
            }
            const configured = userIntents.find(item => item.id === intent && item.enabled);
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
            if (configured?.action?.kind === 'sendTo') {
                return this.processSendTo(
                    request,
                    clientKey,
                    language,
                    configured.action,
                    intent,
                    confidence,
                    model.version,
                    extractParameters(configured.action, text, language, languageRules(language).spokenNumbers),
                    details,
                );
            }
            if (CATALOG_INTENTS.has(intent)) {
                return this.catalogAnswer(request, clientKey, language, intent, confidence, model.version, text);
            }
            if (parsed.negated || hasUnsupportedSyntax(text, language, parsed.unsupported, roomMatches.length)) {
                return this.reject(request, language, 'UNSUPPORTED_SYNTAX');
            }
            action = configured?.action?.kind === 'capability' ? configured.action.operation : SYSTEM_ACTIONS[intent];
            if (!action) {
                return this.reject(request, language, 'UNSUPPORTED_ACTION');
            }
            if (
                !parsed.entities.some(entity => entity.type === 'room') &&
                new RegExp(languageRules(language).roomReference, 'iu').test(text)
            ) {
                const options = resolver.similarRooms(text, language);
                if (!options.length) {
                    return this.reject(request, language, 'UNKNOWN_ROOM');
                }
                const question = responseText(language, 'roomSuggestion', {
                    options: options.map(item => item.label).join(', '),
                });
                const pending = this.sessions.create({
                    key: 'room',
                    clientKey,
                    sessionId: request.sessionId,
                    request: sourceRequest,
                    language,
                    action,
                    intent,
                    confidence,
                    deviceIds: [],
                    roomIds: options.map(item => item.id),
                    options,
                    question,
                });
                return {
                    requestId: request.requestId,
                    status: 'clarification',
                    language,
                    intent,
                    confidence,
                    response: question,
                    clarification: { id: pending.id, key: 'room', options },
                    modelVersion: model.version,
                };
            }
            if (request.mode === 'analyze') {
                const diagnostics = resolver.diagnose(
                    text,
                    language,
                    action,
                    undefined,
                    requestedDomain(intent, action, explicitStringIntent ? stringIntentMatch.prefix : text, language),
                );
                details.functions = diagnostics.functions;
                details.dataPoints = diagnostics.dataPoints;
            }
            if (roomMatches.length > 1) {
                const pending = this.sessions.create({
                    key: 'room',
                    clientKey,
                    sessionId: request.sessionId,
                    request: sourceRequest,
                    language,
                    action,
                    intent,
                    confidence,
                    deviceIds: [],
                    roomIds: roomMatches.map(room => room.id),
                    options: roomMatches,
                    question: responseText(language, 'roomChoices', {
                        options: roomMatches.map(room => room.label).join(', '),
                    }),
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
        const configured = userIntents.find(item => item.id === intent && item.enabled);
        const stringMatch =
            configured?.action?.kind === 'capability' && configured.action.operation === 'setValue'
                ? matchStringPhrase(text, configured.utterances[language] ?? [], language)
                : undefined;
        const domain = requestedDomain(intent, action, stringMatch?.prefix ?? text, language);
        if (request.mode === 'analyze') {
            const diagnostics = resolver.diagnose(text, language, action, forcedRoomId, domain);
            details.devices = diagnostics.devices;
            details.functions = diagnostics.functions;
            details.dataPoints = diagnostics.dataPoints;
        }
        let deviceId = forcedDeviceId;
        let candidates;
        if (!deviceId) {
            const explicitPhrase = new RegExp(languageRules(language).deviceBeforeRoom, 'iu').exec(text)?.groups
                ?.device;
            if (explicitPhrase) {
                const roomIds = new Set(
                    forcedRoomId ? [forcedRoomId] : resolver.roomMatches(text, language).map(room => room.id),
                );
                const eligible = this.catalog
                    .list()
                    .filter(
                        device =>
                            (!roomIds.size || device.roomIds.some(id => roomIds.has(id))) &&
                            device.discoveredCapabilities.some(
                                capability =>
                                    this.catalog.isAllowed(device.id, capability, action) &&
                                    matchesValueDomain(capability, domain, language),
                            ),
                    );
                const deviceNamed = eligible.some(device =>
                    [device.displayName, ...(device.aliases[language] ?? [])].some(
                        name =>
                            normalizeReply(name) === normalizeReply(explicitPhrase) ||
                            similarNameDistance(explicitPhrase, name) !== undefined,
                    ),
                );
                if (!deviceNamed) {
                    const functions = eligible
                        .flatMap(device =>
                            device.functionIds.map(id => {
                                const configured = device.enumNames?.[id];
                                const label =
                                    typeof configured === 'string'
                                        ? configured
                                        : (configured?.[language] ??
                                          Object.values(configured ?? {})[0] ??
                                          id.split('.').at(-1) ??
                                          id);
                                return {
                                    device,
                                    label,
                                    distance: similarNameDistance(explicitPhrase, label) ?? Infinity,
                                };
                            }),
                        )
                        .filter(item => Number.isFinite(item.distance))
                        .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label));
                    if (functions.length) {
                        const closest = functions
                            .filter(item => item.distance <= functions[0].distance + 1)
                            .slice(0, 3);
                        const options = closest.map(item => ({
                            id: item.device.id,
                            label:
                                closest.filter(other => other.label === item.label).length > 1
                                    ? `${item.label} (${item.device.displayName})`
                                    : item.label,
                        }));
                        const question = responseText(language, 'capabilitySuggestion', {
                            options: options.map(item => item.label).join(', '),
                        });
                        const pending = this.sessions.create({
                            key: 'device',
                            clientKey,
                            sessionId: request.sessionId,
                            request: sourceRequest,
                            language,
                            action,
                            intent,
                            confidence,
                            deviceIds: options.map(item => item.id),
                            selectedRoomId: forcedRoomId,
                            options,
                            question,
                        });
                        return {
                            requestId: request.requestId,
                            status: 'clarification',
                            language,
                            intent,
                            confidence,
                            response: question,
                            clarification: { id: pending.id, key: 'device', options },
                            modelVersion: model.version,
                        };
                    }
                }
            }
            const resolution = resolver.resolve(text, language, action, forcedRoomId, domain);
            candidates = resolution.candidates;
            details.candidates = resolution.candidates;
            if (!resolution.candidates.length) {
                if (!forcedRoomId && !resolver.roomMatches(text, language).length) {
                    const eligible = this.catalog
                        .list()
                        .filter(device =>
                            device.discoveredCapabilities.some(
                                capability =>
                                    this.catalog.isAllowed(device.id, capability, action) &&
                                    matchesValueDomain(capability, domain, language),
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
                            request: sourceRequest,
                            language,
                            action,
                            intent,
                            confidence,
                            deviceIds: eligible.map(device => device.id),
                            options,
                            question: responseText(language, 'deviceChoices', {
                                options: options.map(item => item.label).join(', '),
                            }),
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
                const fuzzyCandidates = resolution.candidates.filter(item => item.reasons.includes('fuzzy name'));
                if (fuzzyCandidates.length) {
                    const options = fuzzyCandidates.slice(0, 3).map(item => ({
                        id: item.deviceId,
                        label:
                            this.catalog.list().find(device => device.id === item.deviceId)?.displayName ??
                            item.deviceId,
                    }));
                    const question = responseText(language, 'deviceSuggestion', {
                        options: options.map(item => item.label).join(', '),
                    });
                    const pending = this.sessions.create({
                        key: 'device',
                        clientKey,
                        sessionId: request.sessionId,
                        request: sourceRequest,
                        language,
                        action,
                        intent,
                        confidence,
                        deviceIds: options.map(item => item.id),
                        selectedRoomId: forcedRoomId,
                        options,
                        question,
                    });
                    return {
                        requestId: request.requestId,
                        status: 'clarification',
                        language,
                        intent,
                        confidence,
                        response: question,
                        candidates,
                        clarification: { id: pending.id, key: 'device', options },
                        modelVersion: model.version,
                    };
                }
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
                            request: sourceRequest,
                            language,
                            action,
                            intent,
                            confidence,
                            deviceIds: resolution.candidates.map(item => item.deviceId),
                            roomIds: options.map(item => item.id),
                            options,
                            question: responseText(language, 'roomChoices', {
                                options: options.map(item => item.label).join(', '),
                            }),
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
                    request: sourceRequest,
                    language,
                    action,
                    intent,
                    confidence,
                    deviceIds: resolution.candidates.map(item => item.deviceId),
                    selectedRoomId: forcedRoomId,
                    options,
                    question: responseText(language, 'deviceChoices', {
                        options: options.map(item => item.label).join(', '),
                    }),
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
        if (!selectedStateId && (action === 'getValue' || action === 'setValue')) {
            const device = this.catalog.list().find(item => item.id === deviceId);
            const eligible = (device?.discoveredCapabilities ?? []).filter(
                capability =>
                    this.catalog.isAllowed(deviceId, capability, action) &&
                    matchesValueDomain(capability, domain, language),
            );
            if (!eligible.some(capability => capabilityNameMatches(capability, text, language))) {
                const similar = eligible
                    .map(capability => ({
                        capability,
                        distance: similarNameDistance(text, capabilityName(capability, language)) ?? Infinity,
                    }))
                    .filter(item => Number.isFinite(item.distance))
                    .sort(
                        (a, b) => a.distance - b.distance || a.capability.stateId.localeCompare(b.capability.stateId),
                    );
                if (similar.length) {
                    const options = similar
                        .filter(item => item.distance <= similar[0].distance + 1)
                        .slice(0, 3)
                        .map(item => ({
                            id: item.capability.stateId,
                            label: capabilityName(item.capability, language),
                        }));
                    const question = responseText(language, 'capabilitySuggestion', {
                        options: options.map(item => item.label).join(', '),
                    });
                    const pending = this.sessions.create({
                        key: 'capability',
                        clientKey,
                        sessionId: request.sessionId,
                        request: sourceRequest,
                        language,
                        action,
                        intent,
                        confidence,
                        deviceIds: [deviceId],
                        selectedDeviceId: deviceId,
                        selectedRoomId: forcedRoomId,
                        stateIds: options.map(item => item.id),
                        options,
                        question,
                    });
                    return {
                        requestId: request.requestId,
                        status: 'clarification',
                        language,
                        intent,
                        confidence,
                        response: question,
                        clarification: { id: pending.id, key: 'capability', options },
                        modelVersion: model.version,
                    };
                }
            }
        }
        const selectedDevice = this.catalog.list().find(item => item.id === deviceId);
        const valueParsed = selectedDevice
            ? withoutDeviceNameNumbers(parsed, text, [
                  selectedDevice.displayName,
                  ...(selectedDevice.aliases[language] ?? []),
              ])
            : parsed;
        const outcome = planAction(
            this.catalog,
            deviceId,
            action,
            valueParsed,
            language,
            text,
            domain,
            selectedStateId,
            clarifiedStringValue ?? stringMatch?.value,
        );
        if ('error' in outcome) {
            return this.reject(request, language, outcome.error, intent, confidence);
        }
        if ('clarification' in outcome) {
            if (outcome.clarification === 'capability') {
                const device = this.catalog.list().find(item => item.id === deviceId);
                const names = outcome.stateIds.map(id => {
                    const capability = device?.discoveredCapabilities.find(item => item.stateId === id);
                    return capability ? capabilityLabel(language, capability) : id;
                });
                const options = outcome.stateIds.map(id => {
                    const capability = device?.discoveredCapabilities.find(item => item.stateId === id);
                    const kind = capability ? capabilityLabel(language, capability) : id;
                    const duplicate = names.filter(name => normalizeReply(name) === normalizeReply(kind)).length > 1;
                    return { id, label: duplicate ? `${kind} (${id.split('.').at(-1)})` : kind };
                });
                const pending = this.sessions.create({
                    key: 'capability',
                    clientKey,
                    sessionId: request.sessionId,
                    request: sourceRequest,
                    language,
                    action,
                    intent,
                    confidence,
                    deviceIds: [deviceId],
                    selectedDeviceId: deviceId,
                    selectedRoomId: forcedRoomId,
                    stateIds: outcome.stateIds,
                    options,
                    question: responseText(language, 'capabilityChoices', {
                        options: options.map(item => item.label).join(', '),
                    }),
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
                request: sourceRequest,
                language,
                action,
                intent,
                confidence,
                deviceIds: [deviceId],
                selectedDeviceId: deviceId,
                selectedRoomId: forcedRoomId,
                stateIds: [outcome.stateId],
                question: languageMessage(language, 'valueClarification'),
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
        const requestedEntity = valueParsed.entities.find(
            entity => entity.type === 'number' || entity.type === 'percent' || entity.type === 'temperature',
        );
        const requested =
            plan.capability.valueKind === 'number' && typeof requestedEntity?.value === 'number'
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

    private async processMedia(
        request: CommandRequest,
        clientKey: string,
        language: Language,
        resolver: DeviceResolver,
        details: NonNullable<CommandResult['analysis']>,
        modelVersion?: string,
        forcedDeviceId?: string,
    ): Promise<CommandResult> {
        const rules = relativeLanguageRules(language);
        const normalized = normalizeReply(request.text);
        const next = new RegExp(rules.mediaNext, 'iu').test(normalized);
        const previous = new RegExp(rules.mediaPrevious, 'iu').test(normalized);
        if (next === previous) {
            return this.reject(request, language, 'UNSUPPORTED_SYNTAX');
        }
        const role = next ? 'button.next' : 'button.previous';
        const roomIds = new Set(resolver.roomMatches(request.text, language).map(room => room.id));
        const eligible = this.catalog.list().flatMap(device => {
            const capability = device.discoveredCapabilities.find(
                item => item.role === role && this.catalog.isAllowed(device.id, item, 'press'),
            );
            if (
                !capability ||
                (forcedDeviceId && forcedDeviceId !== device.id) ||
                (roomIds.size && !device.roomIds.some(id => roomIds.has(id)))
            ) {
                return [];
            }
            return [{ device, capability }];
        });
        const named = eligible.filter(({ device }) =>
            [device.displayName, ...(device.aliases[language] ?? [])].some(name =>
                ` ${normalized} `.includes(` ${normalizeReply(name)} `),
            ),
        );
        const candidates = named.length ? named : eligible;
        if (!candidates.length) {
            return this.reject(
                request,
                language,
                'DEVICE_NOT_FOUND_OR_NOT_APPROVED',
                next ? 'device.next' : 'device.previous',
                1,
            );
        }
        if (candidates.length > 1) {
            const options = candidates.slice(0, 8).map(({ device }) => ({ id: device.id, label: device.displayName }));
            const question = responseText(language, 'deviceChoices', {
                options: options.map(item => item.label).join(', '),
            });
            const pending = this.sessions.create({
                key: 'mediaDevice',
                clientKey,
                sessionId: request.sessionId,
                request,
                language,
                action: 'press',
                intent: next ? 'device.next' : 'device.previous',
                confidence: 1,
                deviceIds: options.map(item => item.id),
                options,
                question,
            });
            return {
                requestId: request.requestId,
                status: 'clarification',
                language,
                intent: next ? 'device.next' : 'device.previous',
                confidence: 1,
                response: question,
                clarification: { id: pending.id, key: 'mediaDevice', options },
                modelVersion,
            };
        }
        const { device, capability } = candidates[0];
        const plan: PlannedAction = {
            deviceId: device.id,
            action: 'press',
            capability,
            operation: 'write',
            stateId: capability.stateId,
            value: true,
        };
        details.plan = { action: 'press', operation: 'write', stateId: plan.stateId, value: true };
        const policy = new PolicyEngine(this.catalog, this.io);
        const decision = await policy.validate(plan);
        details.policyDecision = decision.allowed ? 'allowed' : decision.code;
        if (!decision.allowed) {
            return this.reject(request, language, decision.code, next ? 'device.next' : 'device.previous', 1);
        }
        const intent = next ? 'device.next' : 'device.previous';
        if (request.mode === 'analyze') {
            return {
                requestId: request.requestId,
                status: 'success',
                language,
                intent,
                confidence: 1,
                response: responseText(language, 'mediaPlanned', { device: device.displayName }),
                actions: [{ deviceId: device.id, stateId: capability.stateId, status: 'planned', value: true }],
                modelVersion,
            };
        }
        const result = await new CommandExecutor(this.io, policy).execute(plan);
        return {
            requestId: request.requestId,
            status: result.status === 'accepted' ? 'success' : 'error',
            language,
            intent,
            confidence: 1,
            response:
                result.status === 'accepted'
                    ? responseText(language, 'mediaAccepted', { device: device.displayName })
                    : languageMessage(language, `error.${result.message ?? ''}`, 'executionFailed'),
            actions: [result],
            errorCode: result.message,
            modelVersion,
        };
    }

    private async processNamedColor(
        request: CommandRequest,
        clientKey: string,
        language: Language,
        resolver: DeviceResolver,
        color: { hex?: string; kelvin?: number; name: string },
        details: NonNullable<CommandResult['analysis']>,
        modelVersion?: string,
        forcedDeviceId?: string,
    ): Promise<CommandResult> {
        const namedCandidates = resolver
            .resolve(request.text, language, 'setValue')
            .candidates.filter(candidate =>
                forcedDeviceId
                    ? candidate.deviceId === forcedDeviceId
                    : candidate.reasons.includes('exact name or alias'),
            );
        const candidates = namedCandidates.filter(candidate =>
            this.catalog
                .list()
                .some(
                    device =>
                        device.id === candidate.deviceId &&
                        device.discoveredCapabilities.some(
                            capability =>
                                (color.kelvin !== undefined
                                    ? capability.role === 'level.color.temperature'
                                    : capability.role === 'level.color.rgb' ||
                                      capability.role === 'level.color.rgbw') &&
                                this.catalog.isAllowed(device.id, capability, 'setValue'),
                        ),
                ),
        );
        if (!candidates.length) {
            if (
                namedCandidates.some(candidate =>
                    this.catalog
                        .list()
                        .some(
                            device =>
                                device.id === candidate.deviceId &&
                                device.discoveredCapabilities.some(
                                    capability =>
                                        capability.role?.startsWith('level.color.') &&
                                        this.catalog.isAllowed(device.id, capability, 'setValue'),
                                ),
                        ),
                )
            ) {
                return this.reject(request, language, 'COLOR_FORMAT_UNSUPPORTED', 'device.setColor', 1);
            }
            return this.reject(request, language, 'DEVICE_NOT_FOUND_OR_NOT_APPROVED', 'device.setColor', 1);
        }
        if (!forcedDeviceId && candidates[1] && candidates[0].score - candidates[1].score <= 10) {
            const options = candidates.slice(0, 8).map(candidate => ({
                id: candidate.deviceId,
                label: this.catalog.list().find(device => device.id === candidate.deviceId)!.displayName,
            }));
            const question = responseText(language, 'deviceChoices', {
                options: options.map(item => item.label).join(', '),
            });
            const pending = this.sessions.create({
                key: 'colorDevice',
                clientKey,
                sessionId: request.sessionId,
                request,
                language,
                action: 'setValue',
                intent: 'device.setColor',
                confidence: 1,
                deviceIds: options.map(item => item.id),
                options,
                question,
            });
            return {
                requestId: request.requestId,
                status: 'clarification',
                language,
                intent: 'device.setColor',
                confidence: 1,
                response: question,
                clarification: { id: pending.id, key: 'colorDevice', options },
                modelVersion,
            };
        }
        const device = this.catalog.list().find(item => item.id === candidates[0].deviceId)!;
        const capabilities = device.discoveredCapabilities.filter(
            capability =>
                (color.kelvin !== undefined
                    ? capability.role === 'level.color.temperature'
                    : capability.role === 'level.color.rgb' || capability.role === 'level.color.rgbw') &&
                this.catalog.isAllowed(device.id, capability, 'setValue'),
        );
        if (capabilities.length !== 1) {
            return this.reject(request, language, 'AMBIGUOUS_CAPABILITY', 'device.setColor', 1);
        }
        const capability = capabilities[0];
        const value =
            color.kelvin !== undefined
                ? capability.unit === 'K' &&
                  capability.valueKind === 'number' &&
                  capability.min !== undefined &&
                  capability.max !== undefined
                    ? Math.max(capability.min, Math.min(capability.max, color.kelvin))
                    : undefined
                : color.hex
                  ? colorValue(color.hex, capability.role ?? '')
                  : undefined;
        if (value === undefined || typeof value !== capability.valueKind) {
            return this.reject(request, language, 'COLOR_FORMAT_UNSUPPORTED', 'device.setColor', 1);
        }
        const plan: PlannedAction = {
            deviceId: device.id,
            action: 'setValue',
            capability,
            operation: 'write',
            stateId: capability.stateId,
            value,
        };
        details.plan = { action: 'setValue', operation: 'write', stateId: plan.stateId, value };
        const policy = new PolicyEngine(this.catalog, this.io);
        const decision = await policy.validate(plan);
        details.policyDecision = decision.allowed ? 'allowed' : decision.code;
        if (!decision.allowed) {
            return this.reject(request, language, decision.code, 'device.setColor', 1);
        }
        const values = { device: device.displayName, color: color.name };
        if (request.mode === 'analyze') {
            return {
                requestId: request.requestId,
                status: 'success',
                language,
                intent: 'device.setColor',
                confidence: 1,
                response: responseText(language, 'colorPlanned', values),
                actions: [{ deviceId: device.id, stateId: capability.stateId, status: 'planned', value }],
                modelVersion,
            };
        }
        const result = await new CommandExecutor(this.io, policy).execute(plan);
        return {
            requestId: request.requestId,
            status: result.status === 'accepted' ? 'success' : 'error',
            language,
            intent: 'device.setColor',
            confidence: 1,
            response:
                result.status === 'accepted'
                    ? responseText(language, 'colorAccepted', values)
                    : languageMessage(language, `error.${result.message ?? ''}`, 'executionFailed'),
            actions: [result],
            errorCode: result.message,
            modelVersion,
        };
    }

    private async processRelative(
        request: CommandRequest,
        clientKey: string,
        language: Language,
        resolver: DeviceResolver,
        details: NonNullable<CommandResult['analysis']>,
        modelVersion?: string,
        forcedDeviceId?: string,
        forcedStateId?: string,
    ): Promise<CommandResult> {
        const relative = parseRelativeRequest(request.text, language)!;
        if (
            !relative.property &&
            !relative.endpoint &&
            relative.direction !== 'warmer' &&
            relative.direction !== 'cooler'
        ) {
            return this.reject(request, language, 'CAPABILITY_UNSUPPORTED', 'device.adjust', 1);
        }
        if (request.mode === 'analyze') {
            const diagnostics = resolver.diagnose(request.text, language, 'setValue');
            details.devices = diagnostics.devices;
            details.functions = diagnostics.functions;
            details.dataPoints = diagnostics.dataPoints;
        }
        const normalized = normalizeReply(request.text);
        const compact = normalized.replace(/ /g, '');
        const matched = (name: string): number => {
            const value = normalizeReply(name);
            if (!value || value.length < 3) {
                return 0;
            }
            return ` ${normalized} `.includes(` ${value} `)
                ? 100
                : compact.includes(value.replace(/ /g, '')) && value.length >= 5
                  ? 40
                  : 0;
        };
        const mentionedRooms = resolver.roomMatches(request.text, language);
        const eligible = this.catalog
            .list()
            .flatMap(device => {
                if (
                    device.status === 'missing' ||
                    (forcedDeviceId && device.id !== forcedDeviceId) ||
                    (mentionedRooms.length === 1 && !device.roomIds.includes(mentionedRooms[0].id))
                ) {
                    return [];
                }
                let capabilities = device.discoveredCapabilities.filter(capability => {
                    const property =
                        relativePropertyForCapability(capability, relative.property) ??
                        (relative.endpoint && capability.role === 'level' && capability.unit === '%'
                            ? 'genericLevel'
                            : undefined) ??
                        ((capability.role === 'level.color.rgb' || capability.role === 'level.color.rgbw') &&
                        (relative.property === 'brightness' || relative.property === 'saturation')
                            ? relative.property
                            : undefined);
                    return (
                        property &&
                        (!relative.property || relative.property === property) &&
                        (relative.property ||
                            relative.endpoint ||
                            property === 'temperature' ||
                            property === 'colorTemperature') &&
                        capability.readable &&
                        capability.writable &&
                        (!forcedStateId || capability.stateId === forcedStateId) &&
                        this.catalog.isAllowed(device.id, capability, 'setValue')
                    );
                });
                const named = capabilities.filter(capability => matched(capabilityName(capability, language)) === 100);
                if (named.length) {
                    capabilities = named;
                } else {
                    const specific = relative.property
                        ? capabilities.filter(
                              capability => relativePropertyForCapability(capability) === relative.property,
                          )
                        : [];
                    if (specific.length) {
                        capabilities = specific;
                    }
                    if (
                        relative.property === 'brightness' &&
                        capabilities.some(capability => capability.valueKind === 'number')
                    ) {
                        capabilities = capabilities.filter(capability => capability.valueKind === 'number');
                    }
                }
                if (!capabilities.length) {
                    return [];
                }
                const nameScore = Math.max(
                    0,
                    ...[device.displayName, ...(device.aliases[language] ?? [])].map(matched),
                );
                const roomScore = Math.max(
                    0,
                    ...device.roomIds.flatMap(id => roomNames(device, id, language).map(matched)),
                );
                const functionScore = Math.max(
                    0,
                    ...device.functionIds.map(id => {
                        const name = device.enumNames?.[id];
                        return matched(
                            typeof name === 'string' ? name : (name?.[language] ?? id.split('.').at(-1) ?? id),
                        );
                    }),
                );
                if (!relative.property && nameScore === 0 && functionScore === 0) {
                    return [];
                }
                const score = nameScore * 2 + roomScore + functionScore;
                return score > 0 || forcedDeviceId ? [{ device, capabilities, score }] : [];
            })
            .sort((a, b) => b.score - a.score || a.device.id.localeCompare(b.device.id));
        if (!eligible.length) {
            return this.reject(request, language, 'DEVICE_NOT_FOUND_OR_NOT_APPROVED', 'device.adjust', 1);
        }
        if (!forcedDeviceId && eligible[1] && eligible[0].score - eligible[1].score <= 20) {
            const options = eligible.slice(0, 8).map(item => ({ id: item.device.id, label: item.device.displayName }));
            const question = responseText(language, 'deviceChoices', {
                options: options.map(item => item.label).join(', '),
            });
            const pending = this.sessions.create({
                key: 'relativeDevice',
                clientKey,
                sessionId: request.sessionId,
                request,
                language,
                action: 'setValue',
                intent: 'device.adjust',
                confidence: 1,
                deviceIds: options.map(item => item.id),
                options,
                question,
            });
            return {
                requestId: request.requestId,
                status: 'clarification',
                language,
                intent: 'device.adjust',
                confidence: 1,
                response: question,
                clarification: { id: pending.id, key: 'relativeDevice', options },
                modelVersion,
            };
        }
        const { device, capabilities } = eligible[0];
        const explicitlyNamed = device.discoveredCapabilities.filter(
            capability => matched(capabilityName(capability, language)) === 100,
        );
        if (explicitlyNamed.length === 1 && !capabilities.some(item => item.stateId === explicitlyNamed[0].stateId)) {
            const named = explicitlyNamed[0];
            return this.reject(
                request,
                language,
                this.catalog.isAllowed(device.id, named, 'setValue') ? 'CAPABILITY_UNSUPPORTED' : 'ACTION_NOT_APPROVED',
                'device.adjust',
                1,
            );
        }
        if (capabilities.length !== 1) {
            const exact = capabilities.filter(item => matched(capabilityName(item, language)) === 100);
            if (exact.length === 1) {
                capabilities.splice(0, capabilities.length, exact[0]);
            }
        }
        if (capabilities.length !== 1) {
            const options = capabilities.map(item => ({ id: item.stateId, label: capabilityName(item, language) }));
            const question = responseText(language, 'capabilityChoices', {
                options: options.map(item => item.label).join(', '),
            });
            const pending = this.sessions.create({
                key: 'relativeCapability',
                clientKey,
                sessionId: request.sessionId,
                request,
                language,
                action: 'setValue',
                intent: 'device.adjust',
                confidence: 1,
                deviceIds: [device.id],
                selectedDeviceId: device.id,
                stateIds: options.map(item => item.id),
                options,
                question,
            });
            return {
                requestId: request.requestId,
                status: 'clarification',
                language,
                intent: 'device.adjust',
                confidence: 1,
                response: question,
                clarification: { id: pending.id, key: 'relativeCapability', options },
                modelVersion,
            };
        }
        const capability = capabilities[0];
        const rgbColor = capability.role === 'level.color.rgb' || capability.role === 'level.color.rgbw';
        const property = rgbColor
            ? relative.property!
            : (relativePropertyForCapability(capability, relative.property) ?? 'genericLevel');
        const discreteFan = property === 'fanSpeed' && (capability.enumValues?.length ?? 0) > 1;
        if (!rgbColor && !discreteFan && (capability.min === undefined || capability.max === undefined)) {
            return this.reject(request, language, 'MISSING_RANGE', 'device.adjust', 1);
        }
        const unit = discreteFan
            ? 'enum'
            : rgbColor
              ? '%'
              : property === 'colorTemperature'
                ? 'K'
                : (capability.unit ?? '');
        if (property !== 'genericLevel' && !defaultProfiles[property][unit]) {
            return this.reject(request, language, 'CAPABILITY_UNSUPPORTED', 'device.adjust', 1);
        }
        if (
            capability.step !== undefined &&
            (!Number.isFinite(capability.step) ||
                capability.step <= 0 ||
                (unit === '°C' ? capability.step % 0.5 !== 0 : !discreteFan && !Number.isInteger(capability.step)))
        ) {
            return this.reject(request, language, 'CAPABILITY_UNSUPPORTED', 'device.adjust', 1);
        }
        const basePlan: PlannedAction = {
            deviceId: device.id,
            action: 'setValue',
            capability,
            operation: 'write',
            stateId: capability.stateId,
        };
        const run = async (): Promise<CommandResult> => {
            const absoluteEndpoint = !!relative.endpoint && !rgbColor && !discreteFan;
            const state = absoluteEndpoint ? undefined : await this.io.getState(capability.stateId);
            if (!absoluteEndpoint) {
                const currentState: NonNullable<CommandResult['analysis']>['currentState'] = {
                    stateId: capability.stateId,
                    valueType: !state ? 'missing' : state.val === null ? 'null' : typeof state.val,
                    ...(state && (state.val === null || ['string', 'number', 'boolean'].includes(typeof state.val))
                        ? { value: state.val as string | number | boolean | null }
                        : {}),
                    ...(state?.q !== undefined ? { quality: state.q } : {}),
                };
                details.currentState = currentState;
                if (!state) {
                    currentState.issue = 'missing';
                    return this.reject(request, language, 'INVALID_CURRENT_VALUE', 'device.adjust', 1);
                }
                if (state.q !== undefined && state.q !== 0) {
                    currentState.issue = 'quality';
                    return this.reject(request, language, 'INVALID_CURRENT_VALUE', 'device.adjust', 1);
                }
                if (
                    rgbColor
                        ? typeof state.val !== 'string'
                        : typeof state.val !== 'number' || !Number.isFinite(state.val)
                ) {
                    currentState.issue = 'type';
                    return this.reject(request, language, 'INVALID_CURRENT_VALUE', 'device.adjust', 1);
                }
                if (
                    !rgbColor &&
                    !discreteFan &&
                    ((state.val as number) < capability.min! || (state.val as number) > capability.max!)
                ) {
                    currentState.issue = 'range';
                    return this.reject(request, language, 'INVALID_CURRENT_VALUE', 'device.adjust', 1);
                }
            }
            const profileKey = `${property}:${unit}`;
            const profile = {
                ...(capability.step ? { step: capability.step } : {}),
                ...(this.catalog.getRelativeProfiles?.()[profileKey] ?? {}),
                ...(device.relativeProfiles?.[capability.stateId]?.[profileKey] ?? {}),
            };
            if (profile.enabled === false) {
                return this.reject(request, language, 'CAPABILITY_UNSUPPORTED', 'device.adjust', 1);
            }
            if (
                absoluteEndpoint &&
                (!Number.isFinite(capability.min) ||
                    !Number.isFinite(capability.max) ||
                    capability.min! >= capability.max!)
            ) {
                return this.reject(request, language, 'MISSING_RANGE', 'device.adjust', 1);
            }
            const target = absoluteEndpoint
                ? relative.endpoint === 'min'
                    ? capability.min!
                    : capability.max!
                : rgbColor
                  ? adjustHexColor(
                        state!.val as string,
                        capability.role!,
                        property as 'brightness' | 'saturation',
                        relative,
                        profile,
                    )
                  : discreteFan
                    ? enumRelativeTarget(state!.val as number, capability.enumValues!, relative, profile)
                    : relativeTarget(
                          state!.val as number,
                          capability.min!,
                          capability.max!,
                          property as RelativeProperty,
                          unit,
                          relative,
                          profile,
                      );
            if (target === undefined) {
                return this.reject(request, language, 'CAPABILITY_UNSUPPORTED', 'device.adjust', 1);
            }
            details.relative = {
                operation: relative.endpoint ? 'set' : discreteFan ? 'step' : 'adjust',
                property,
                intensity: relative.intensity,
                ...(state ? { previousValue: state.val as number | string } : {}),
                targetValue: target,
                ...(state && typeof target === 'number' && typeof state.val === 'number'
                    ? { appliedDelta: target - state.val }
                    : {}),
                unit,
                source: Object.keys(device.relativeProfiles?.[capability.stateId]?.[profileKey] ?? {}).length
                    ? 'device'
                    : Object.keys(this.catalog.getRelativeProfiles?.()[profileKey] ?? {}).length
                      ? 'global'
                      : 'builtIn',
            };
            const plan: PlannedAction = { ...basePlan, value: target };
            details.plan = { action: 'setValue', operation: 'write', stateId: plan.stateId, value: target };
            const policy = new PolicyEngine(this.catalog, this.io);
            const decision = await policy.validate(plan);
            details.policyDecision = decision.allowed ? 'allowed' : decision.code;
            if (!decision.allowed) {
                return this.reject(request, language, decision.code, 'device.adjust', 1);
            }
            const values = { device: device.displayName, value: String(target), unit };
            if (state && target === state.val) {
                return {
                    requestId: request.requestId,
                    status: 'success',
                    language,
                    intent: 'device.adjust',
                    confidence: 1,
                    response: responseText(language, 'relativeNoChange', values),
                    modelVersion,
                    actions: [{ deviceId: device.id, stateId: capability.stateId, status: 'planned', value: target }],
                };
            }
            if (request.mode === 'analyze') {
                return {
                    requestId: request.requestId,
                    status: 'success',
                    language,
                    intent: 'device.adjust',
                    confidence: 1,
                    response: responseText(language, 'relativePlanned', values),
                    modelVersion,
                    actions: [{ deviceId: device.id, stateId: capability.stateId, status: 'planned', value: target }],
                };
            }
            const result = await new CommandExecutor(this.io, policy).execute(plan);
            return {
                requestId: request.requestId,
                status: result.status === 'accepted' ? 'success' : 'error',
                language,
                intent: 'device.adjust',
                confidence: 1,
                modelVersion,
                errorCode: result.message,
                response:
                    result.status === 'accepted'
                        ? responseText(language, 'relativeAccepted', values)
                        : languageMessage(language, `error.${result.message ?? ''}`, 'executionFailed'),
                actions: [result],
            };
        };
        if (request.mode === 'analyze') {
            return run();
        }
        const previous = this.relativeQueues.get(capability.stateId) ?? Promise.resolve();
        let release!: () => void;
        const barrier = new Promise<void>(resolve => {
            release = resolve;
        });
        const next = previous.then(() => barrier);
        this.relativeQueues.set(capability.stateId, next);
        await previous;
        try {
            return await run();
        } finally {
            release();
            if (this.relativeQueues.get(capability.stateId) === next) {
                this.relativeQueues.delete(capability.stateId);
            }
        }
    }

    private catalogAnswer(
        request: CommandRequest,
        clientKey: string,
        language: Language,
        intent: string,
        confidence: number,
        modelVersion: string | undefined,
        text: string,
        forcedRoomId?: string,
        forcedDeviceId?: string,
    ): CommandResult {
        const visible = this.catalog
            .list()
            .filter(device =>
                device.discoveredCapabilities.some(capability =>
                    CAPABILITY_ACTIONS.some(action => this.catalog.isAllowed(device.id, capability, action)),
                ),
            );
        const allRooms = new Map<string, string>();
        for (const device of visible) {
            for (const id of device.roomIds) {
                allRooms.set(id, roomNames(device, id, language).at(-1) ?? id);
            }
        }
        const sorted = (items: string[]): string =>
            new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(
                [...new Set(items)].sort((a, b) => a.localeCompare(b, language)),
            );
        const result = (
            response: string,
            status: CommandResult['status'] = 'success',
            errorCode?: string,
        ): CommandResult => ({
            requestId: request.requestId,
            status,
            language,
            intent,
            confidence,
            response,
            errorCode,
            modelVersion,
        });
        if (intent === 'device.listRooms') {
            const names = [...allRooms.values()];
            return result(
                responseText(language, names.length ? 'catalog.rooms' : 'catalog.noRooms', { items: sorted(names) }),
            );
        }
        const resolver = new DeviceResolver(this.catalog);
        const roomMatches = forcedRoomId
            ? [{ id: forcedRoomId, label: allRooms.get(forcedRoomId) ?? forcedRoomId }]
            : resolver.roomMatches(text, language).filter(room => allRooms.has(room.id));
        const roomOptions = [...allRooms].map(([id, label]) => ({ id, label }));
        if (!roomMatches.length && new RegExp(languageRules(language).roomReference, 'iu').test(text)) {
            const options = resolver.similarRooms(text, language).filter(item => allRooms.has(item.id));
            if (options.length) {
                const question = responseText(language, 'roomSuggestion', {
                    options: sorted(options.map(item => item.label)),
                });
                const pending = this.sessions.create({
                    key: 'room',
                    clientKey,
                    sessionId: request.sessionId,
                    request,
                    language,
                    action: intent === 'device.listDevices' ? 'listDevices' : 'listFunctions',
                    intent,
                    confidence,
                    deviceIds: [],
                    roomIds: options.map(item => item.id),
                    options,
                    question,
                });
                return {
                    ...result(question, 'clarification'),
                    clarification: { id: pending.id, key: 'room', options },
                };
            }
            return result(languageMessage(language, 'error.UNKNOWN_ROOM'), 'rejected', 'UNKNOWN_ROOM');
        }
        if (roomMatches.length !== 1) {
            if (!roomOptions.length) {
                return result(languageMessage(language, 'catalog.noRooms'));
            }
            const options = roomMatches.length ? roomMatches : roomOptions;
            const key = roomMatches.length ? 'roomChoices' : 'catalog.askRoom';
            const question = responseText(language, key, { options: sorted(options.map(item => item.label)) });
            const pending = this.sessions.create({
                key: 'room',
                clientKey,
                sessionId: request.sessionId,
                request,
                language,
                action: intent === 'device.listDevices' ? 'listDevices' : 'listFunctions',
                intent,
                confidence,
                deviceIds: [],
                roomIds: options.map(item => item.id),
                options,
                question,
            });
            return { ...result(question, 'clarification'), clarification: { id: pending.id, key: 'room', options } };
        }
        const room = roomMatches[0];
        const devices = visible.filter(device => device.roomIds.includes(room.id));
        if (intent === 'device.listDevices') {
            return result(
                responseText(language, devices.length ? 'catalog.devices' : 'catalog.noDevices', {
                    room: room.label,
                    items: sorted(devices.map(device => device.displayName)),
                }),
            );
        }
        if (!devices.length) {
            return result(responseText(language, 'catalog.noDevices', { room: room.label }));
        }
        const named = forcedDeviceId
            ? devices.filter(device => device.id === forcedDeviceId)
            : devices.filter(device =>
                  [device.displayName, ...(device.aliases[language] ?? [])].some(name => {
                      const phrase = normalizeReply(name);
                      return phrase && ` ${normalizeReply(text)} `.includes(` ${phrase} `);
                  }),
              );
        if (!named.length && !forcedDeviceId) {
            const similar = devices
                .map(device => ({
                    device,
                    distance: Math.min(
                        ...[device.displayName, ...(device.aliases[language] ?? [])].map(
                            name => similarNameDistance(text, name) ?? Infinity,
                        ),
                    ),
                }))
                .filter(item => Number.isFinite(item.distance))
                .sort((a, b) => a.distance - b.distance || a.device.displayName.localeCompare(b.device.displayName));
            if (similar.length) {
                const options = similar
                    .filter(item => item.distance <= similar[0].distance + 1)
                    .slice(0, 3)
                    .map(item => ({ id: item.device.id, label: item.device.displayName }));
                const question = responseText(language, 'deviceSuggestion', {
                    options: sorted(options.map(item => item.label)),
                });
                const pending = this.sessions.create({
                    key: 'device',
                    clientKey,
                    sessionId: request.sessionId,
                    request,
                    language,
                    action: 'listFunctions',
                    intent,
                    confidence,
                    deviceIds: options.map(item => item.id),
                    selectedRoomId: room.id,
                    options,
                    question,
                });
                return {
                    ...result(question, 'clarification'),
                    clarification: { id: pending.id, key: 'device', options },
                };
            }
        }
        if (!named.length && new RegExp(languageRules(language).catalogDeviceReference, 'iu').test(text)) {
            return result(languageMessage(language, 'deviceNotFoundInRoom'), 'rejected', 'DEVICE_NOT_FOUND');
        }
        const matches: DeviceRecord[] = named.length ? named : devices.length === 1 ? devices : [];
        if (matches.length !== 1) {
            const options = (matches.length ? matches : devices).map(device => ({
                id: device.id,
                label: device.displayName,
            }));
            const question = responseText(language, matches.length ? 'deviceChoices' : 'catalog.askDevice', {
                options: sorted(options.map(item => item.label)),
            });
            const pending = this.sessions.create({
                key: 'device',
                clientKey,
                sessionId: request.sessionId,
                request,
                language,
                action: 'listFunctions',
                intent,
                confidence,
                deviceIds: options.map(item => item.id),
                selectedRoomId: room.id,
                options,
                question,
            });
            return { ...result(question, 'clarification'), clarification: { id: pending.id, key: 'device', options } };
        }
        const device = matches[0];
        const functions = device.discoveredCapabilities
            .filter(capability =>
                CAPABILITY_ACTIONS.some(action => this.catalog.isAllowed(device.id, capability, action)),
            )
            .map(capability =>
                capability.kind === 'onOff'
                    ? languageMessage(language, 'catalog.switchFunction')
                    : capabilityName(capability, language),
            );
        return result(
            responseText(language, functions.length ? 'catalog.functions' : 'catalog.noFunctions', {
                device: device.displayName,
                room: room.label,
                items: sorted(functions),
            }),
        );
    }

    private repeatClarification(
        request: CommandRequest,
        pending: PendingClarification,
        modelVersion?: string,
    ): CommandResult {
        return {
            requestId: request.requestId,
            status: 'clarification',
            language: pending.language,
            intent: pending.intent,
            confidence: pending.confidence,
            response: [languageMessage(pending.language, 'clarificationMismatch'), pending.question]
                .filter(Boolean)
                .join(' '),
            errorCode: 'INVALID_SELECTION',
            clarification: {
                id: pending.id,
                key: pending.key,
                options: pending.options,
                parameter: pending.parameterName,
            },
            modelVersion,
        };
    }

    private async processSendTo(
        request: CommandRequest,
        clientKey: string,
        language: Language,
        action: SendToIntentAction,
        intent: string,
        confidence: number,
        modelVersion: string | undefined,
        values: Record<string, string | number>,
        details: NonNullable<CommandResult['analysis']>,
        selection?: SendToSelection,
    ): Promise<CommandResult> {
        const missing = action.parameters.filter(item => values[item.name] === undefined);
        details.sendTo = {
            instance: action.instance,
            command: action.command,
            parameters: values,
            missing: missing.map(item => item.name),
        };
        if (missing.length) {
            const parameter = missing[0];
            const question = parameter.prompt[language] ?? parameter.prompt[this.defaultLanguage] ?? '';
            const pending = this.sessions.create({
                key: 'parameter',
                clientKey,
                sessionId: request.sessionId,
                request,
                language,
                action: 'sendTo',
                intent,
                confidence,
                deviceIds: [],
                question,
                parameterName: parameter.name,
                parameterValues: values,
            });
            return {
                requestId: request.requestId,
                status: 'clarification',
                language,
                intent,
                confidence,
                response: question,
                clarification: { id: pending.id, key: 'parameter', parameter: parameter.name },
                modelVersion,
            };
        }
        if (request.mode === 'analyze') {
            return {
                requestId: request.requestId,
                status: 'success',
                language,
                intent,
                confidence,
                response: languageMessage(language, 'planned'),
                modelVersion,
            };
        }
        if (!this.sendOutbound) {
            return this.sendToError(request, language, intent, confidence, modelVersion, 'SENDTO_UNAVAILABLE');
        }
        try {
            const rawCallback = await this.sendOutbound(
                action.instance,
                action.command,
                fillPayload(action.payloadTemplate, values, selection),
            );
            details.sendTo.rawCallback = diagnosticSnapshot(rawCallback);
            if (rawCallback instanceof Error) {
                throw rawCallback;
            }
            const result =
                rawCallback &&
                typeof rawCallback === 'object' &&
                'message' in rawCallback &&
                !('version' in rawCallback)
                    ? rawCallback.message
                    : rawCallback;
            details.sendTo.message = diagnosticSnapshot(result);
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
                return this.sendToError(request, language, intent, confidence, modelVersion, 'SENDTO_INVALID_RESPONSE');
            }
            const reply = result as Record<string, unknown>;
            if (
                reply.version !== 1 ||
                (reply.status !== 'success' && reply.status !== 'error' && reply.status !== 'clarification') ||
                typeof reply.text !== 'string' ||
                !reply.text.trim() ||
                reply.text.length > 2000
            ) {
                return this.sendToError(request, language, intent, confidence, modelVersion, 'SENDTO_INVALID_RESPONSE');
            }
            if (reply.status === 'clarification') {
                const options = reply.options;
                if (
                    !hasClarificationPlaceholder(action.payloadTemplate) ||
                    !Array.isArray(options) ||
                    options.length < 2 ||
                    options.length > 10 ||
                    options.some(
                        option =>
                            !option ||
                            typeof option !== 'object' ||
                            typeof option.id !== 'string' ||
                            !option.id.trim() ||
                            option.id.length > 100 ||
                            typeof option.label !== 'string' ||
                            !option.label.trim() ||
                            option.label.length > 200 ||
                            typeof option.value !== 'string' ||
                            !option.value.trim() ||
                            option.value.length > 2000,
                    ) ||
                    new Set(options.map(option => normalizeReply(option.id))).size !== options.length
                ) {
                    return this.sendToError(
                        request,
                        language,
                        intent,
                        confidence,
                        modelVersion,
                        'SENDTO_INVALID_RESPONSE',
                    );
                }
                const choices = options.map(option => ({ id: option.id as string, label: option.label as string }));
                const pending = this.sessions.create({
                    key: 'sendToOption',
                    clientKey,
                    sessionId: request.sessionId,
                    request,
                    language,
                    action: 'sendTo',
                    intent,
                    confidence,
                    deviceIds: [],
                    question: reply.text,
                    options: choices,
                    optionValues: Object.fromEntries(options.map(option => [option.id, option.value])),
                    parameterValues: values,
                });
                return {
                    requestId: request.requestId,
                    status: 'clarification',
                    language,
                    intent,
                    confidence,
                    response: reply.text,
                    clarification: { id: pending.id, key: 'sendToOption', options: choices },
                    modelVersion,
                };
            }
            return {
                requestId: request.requestId,
                status: reply.status,
                language,
                intent,
                confidence,
                response: reply.text,
                errorCode: reply.status === 'error' ? 'SENDTO_TARGET_ERROR' : undefined,
                modelVersion,
            };
        } catch (error) {
            details.sendTo.transportError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
            this.reportError?.(error, request.requestId);
            return this.sendToError(request, language, intent, confidence, modelVersion, 'SENDTO_FAILED');
        }
    }

    private sendToError(
        request: CommandRequest,
        language: Language,
        intent: string,
        confidence: number,
        modelVersion: string | undefined,
        code: string,
    ): CommandResult {
        return {
            requestId: request.requestId,
            status: 'error',
            language,
            intent,
            confidence,
            errorCode: code,
            response: languageMessage(language, `error.${code}`),
            modelVersion,
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
