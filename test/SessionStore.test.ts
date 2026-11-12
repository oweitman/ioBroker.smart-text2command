import { expect } from 'chai';
import { SessionStore } from '../src/dialog/SessionStore';

describe('dialog sessions', () => {
    it('expires after five minutes and binds a question to caller and session', () => {
        let now = 1000;
        const store = new SessionStore(5 * 60_000, 100, () => now);
        const pending = store.create({
            key: 'device',
            clientKey: 'adapter-a:user-a',
            sessionId: 'speaker-a',
            request: { requestId: 'first', sessionId: 'speaker-a', text: 'Welche Temperatur', mode: 'execute' },
            language: 'de',
            action: 'getValue',
            intent: 'device.getValue',
            confidence: 0.9,
            deviceIds: ['test.0.sensor'],
        });
        expect(store.get(pending.id, 'adapter-a:user-b', 'speaker-a')).to.equal(undefined);
        expect(store.get(pending.id, 'adapter-a:user-a', 'speaker-b')).to.equal(undefined);
        now += 5 * 60_000 - 1;
        expect(store.get(pending.id, 'adapter-a:user-a', 'speaker-a')).to.equal(pending);
        now += 1;
        expect(store.get(pending.id, 'adapter-a:user-a', 'speaker-a')).to.equal(undefined);
    });
});
