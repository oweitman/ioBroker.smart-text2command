export type Language = string;
export type CommandMode = 'analyze' | 'execute';

export interface CommandRequest {
    requestId: string;
    sessionId?: string;
    language?: Language;
    text: string;
    mode: CommandMode;
    clarificationId?: string;
    selection?: string;
}

export type ErrorCode =
    | 'INVALID_REQUEST'
    | 'TEXT_TOO_LONG'
    | 'MODEL_UNAVAILABLE'
    | 'DEVICE_NOT_FOUND'
    | 'ACTION_NOT_APPROVED'
    | 'CAPABILITY_CHANGED'
    | 'AMBIGUOUS_DEVICE'
    | 'UNSUPPORTED_ACTION'
    | 'STORAGE_ERROR';

export class RequestError extends Error {
    public constructor(
        public readonly code: ErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'RequestError';
    }
}
