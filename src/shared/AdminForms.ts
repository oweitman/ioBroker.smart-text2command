import type { ActionKind, DeviceRecord } from '../devices/types';
import type { IntentDefinition } from '../nlp/types';
import { validateSendToAction } from '../nlp/SendToAction';
import languages from '../../resources/languages.json';

const ACTIONS = new Set<ActionKind>(['turnOn', 'turnOff', 'setValue', 'press', 'getState', 'getValue']);

export function parseAliases(input: string): string[] {
    const aliases = input
        .split(/[,\n]/)
        .map(value => value.trim())
        .filter(Boolean);
    if (aliases.length > 30 || aliases.some(value => value.length > 100)) {
        throw new Error('Invalid aliases');
    }
    const unique = new Set(aliases.map(value => value.toLocaleLowerCase()));
    if (unique.size !== aliases.length) {
        throw new Error('Duplicate aliases');
    }
    return aliases;
}

export function normalizeIntentDraft(draft: IntentDefinition): IntentDefinition {
    return {
        ...draft,
        utterances: Object.fromEntries(
            Object.entries(draft.utterances).map(([language, examples]) => [
                language,
                (examples ?? []).map(text => text.trim()).filter(Boolean),
            ]),
        ),
    };
}

export function validateApproval(device: DeviceRecord, stateId: string, action: ActionKind): void {
    if (device.status === 'missing') {
        throw new Error('Device is missing');
    }
    const capability = device.discoveredCapabilities.find(item => item.stateId === stateId);
    if (!capability || !ACTIONS.has(action)) {
        throw new Error('Capability is unavailable');
    }
    if (action.startsWith('get') ? !capability.readable : !capability.writable) {
        throw new Error('Action is incompatible');
    }
}

export function validateIntentDraft(draft: IntentDefinition): void {
    if (
        draft.source !== 'user' ||
        !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(draft.id) ||
        draft.id.startsWith('device.') ||
        draft.id === 'None'
    ) {
        throw new Error('Invalid intent ID');
    }
    for (const { code: language } of languages) {
        const examples = draft.utterances[language] ?? [];
        if (examples.length < 2 || examples.some(text => !text.trim() || text.length > 1000)) {
            throw new Error(`At least two valid ${language} examples required`);
        }
    }
    if (
        !draft.action ||
        !['capability', 'response', 'sendTo'].includes(draft.action.kind) ||
        (draft.action.kind === 'capability' && !ACTIONS.has(draft.action.operation)) ||
        (draft.action.kind === 'response' && !Object.values(draft.action.response).some(text => !!text?.trim()))
    ) {
        throw new Error('Select a valid action');
    }
    if (draft.action.kind === 'sendTo') {
        validateSendToAction(draft.action);
    }
}
