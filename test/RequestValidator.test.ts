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
});
