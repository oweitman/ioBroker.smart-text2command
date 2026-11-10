import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntentRepository } from '../src/nlp/IntentRepository';

describe('user intent storage', () => {
    it('persists explicit typed actions and rejects reserved IDs', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'smart-text2command-intents-'));
        try {
            const repository = new IntentRepository(join(dir, 'user-intents-v1.json'));
            expect(await repository.load()).to.deep.equal([]);
            await repository.save([
                {
                    id: 'user.readKitchen',
                    source: 'user',
                    enabled: true,
                    utterances: { de: ['Wie warm ist es in der Küche'] },
                    action: { kind: 'capability', operation: 'getValue' },
                },
            ]);
            expect((await repository.load())[0].action).to.deep.equal({ kind: 'capability', operation: 'getValue' });
            try {
                await repository.save([
                    {
                        id: 'device.turnOn',
                        source: 'user',
                        enabled: true,
                        utterances: {},
                        action: { kind: 'capability', operation: 'turnOn' },
                    },
                ]);
                expect.fail('reserved ID was accepted');
            } catch (error) {
                expect(String(error)).to.contain('Invalid user intent');
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
