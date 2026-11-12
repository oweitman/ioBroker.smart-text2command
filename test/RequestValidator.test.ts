import { expect } from 'chai';
import { validateCommandRequest } from '../src/api/RequestValidator';
import { RequestError } from '../src/types/api';

describe('request schema', () => {
    it('accepts a bounded German analysis request', () => {
        const request = validateCommandRequest({
            requestId: 'req-1',
            text: 'Schalte die Lampe ein',
            mode: 'analyze',
            language: 'de',
        });
        expect(request.mode).to.equal('analyze');
    });

    it('rejects malformed and overlong input', () => {
        expect(() => validateCommandRequest({ requestId: 'a', text: 'x'.repeat(1001), mode: 'execute' }))
            .to.throw(RequestError)
            .with.property('code', 'TEXT_TOO_LONG');
        expect(() => validateCommandRequest({ requestId: 'a', text: 'ok', mode: 'execute', language: 'fr' }))
            .to.throw(RequestError)
            .with.property('code', 'INVALID_REQUEST');
        expect(() => validateCommandRequest({ requestId: 'a', text: 'ok', mode: 'execute', selection: '1' }))
            .to.throw(RequestError)
            .with.property('code', 'INVALID_REQUEST');
    });

    it('accepts text-only answers with a clarification ID and rejects a selection without one', () => {
        const answer = {
            requestId: 'answer-1',
            sessionId: 'speaker-a',
            text: 'Wohnzimmer',
            mode: 'execute',
            clarificationId: 'clarification-1',
        };
        expect(validateCommandRequest(answer)).to.deep.equal(answer);
        expect(() => validateCommandRequest({ ...answer, clarificationId: undefined, selection: 'room-1' })).to.throw(
            'Selection requires clarificationId',
        );
    });
});
