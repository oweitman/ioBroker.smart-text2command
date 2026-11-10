import type { CommandRequest } from '../types/api';
import { RequestError } from '../types/api';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
export function validateCommandRequest(input: unknown): CommandRequest {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new RequestError('INVALID_REQUEST', 'Request must be an object');
    }
    const value = input as Record<string, unknown>;
    if (typeof value.requestId !== 'string' || !ID_PATTERN.test(value.requestId)) {
        throw new RequestError('INVALID_REQUEST', 'Invalid requestId');
    }
    if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || !ID_PATTERN.test(value.sessionId))) {
        throw new RequestError('INVALID_REQUEST', 'Invalid sessionId');
    }
    if (value.language !== undefined && value.language !== 'de' && value.language !== 'en') {
        throw new RequestError('INVALID_REQUEST', 'Unsupported language');
    }
    if (value.mode !== 'analyze' && value.mode !== 'execute') {
        throw new RequestError('INVALID_REQUEST', 'Invalid mode');
    }
    if (typeof value.text !== 'string' || !value.text.trim()) {
        throw new RequestError('INVALID_REQUEST', 'Text is required');
    }
    if (value.text.length > 1000) {
        throw new RequestError('TEXT_TOO_LONG', 'Text exceeds 1000 characters');
    }
    if (
        value.clarificationId !== undefined &&
        (typeof value.clarificationId !== 'string' || !ID_PATTERN.test(value.clarificationId))
    ) {
        throw new RequestError('INVALID_REQUEST', 'Invalid clarificationId');
    }
    if (
        value.selection !== undefined &&
        (typeof value.selection !== 'string' ||
            !value.selection.trim() ||
            value.selection.length > 100 ||
            [...value.selection].some(character => character.charCodeAt(0) < 32))
    ) {
        throw new RequestError('INVALID_REQUEST', 'Invalid selection');
    }
    if ((value.clarificationId === undefined) !== (value.selection === undefined)) {
        throw new RequestError('INVALID_REQUEST', 'Clarification and selection must be provided together');
    }
    return value as unknown as CommandRequest;
}
