import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestLabHistoryRepository } from '../src/storage/TestLabHistoryRepository';
import type { CommandRequest } from '../src/types/api';
import type { CommandResult } from '../src/commands/types';

describe('test lab session history', () => {
    it('persists full analysis responses, separates sessions, and applies retention limits', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'smart-text2command-history-'));
        try {
            const file = join(directory, 'history.json');
            const history = new TestLabHistoryRepository(file, 2, 2);
            const append = (sessionId: string, requestId: string, text: string): Promise<void> => {
                const request: CommandRequest = { sessionId, requestId, text, mode: 'analyze', language: 'de' };
                const result: CommandResult = {
                    requestId,
                    status: 'success',
                    language: 'de',
                    response: 'Aktion geplant.',
                    analysis: {
                        functions: [
                            {
                                deviceId: 'test.0.lamp',
                                deviceName: 'Lampe',
                                functionId: 'enum.functions.light',
                                name: 'Licht',
                                mentioned: true,
                            },
                        ],
                        dataPoints: [
                            {
                                deviceId: 'test.0.lamp',
                                deviceName: 'Lampe',
                                stateId: 'test.0.lamp.POWER',
                                name: 'POWER',
                                kind: 'onOff',
                                readable: true,
                                writable: true,
                                actionAllowed: true,
                                domainMatched: true,
                                nameMatched: false,
                            },
                        ],
                    },
                };
                return history.append(request, result);
            };
            await Promise.all([
                append('session-a', 'a1', 'Schalte Lampe ein'),
                append('session-a', 'a2', 'Schalte Lampe aus'),
                append('session-a', 'a3', 'Ist die Lampe an'),
            ]);
            const reloaded = new TestLabHistoryRepository(file, 2, 2);
            const first = await reloaded.get('session-a');
            expect(first?.exchanges.map(item => item.request.requestId)).to.deep.equal(['a2', 'a3']);
            expect(first?.exchanges[0].result.analysis?.dataPoints?.[0].stateId).to.equal('test.0.lamp.POWER');
            await reloaded.append(
                { sessionId: 'session-b', requestId: 'b1', text: 'Welche Temperatur', mode: 'analyze' },
                { requestId: 'b1', status: 'clarification', language: 'de', response: 'Welcher Raum?' },
            );
            await reloaded.append(
                { sessionId: 'session-c', requestId: 'c1', text: 'Wohnzimmer', mode: 'analyze' },
                { requestId: 'c1', status: 'success', language: 'de', response: '21 Grad' },
            );
            expect((await reloaded.list()).map(item => item.id)).to.deep.equal(['session-c', 'session-b']);
            expect(await reloaded.get('session-a')).to.be.undefined;
            await reloaded.delete('session-b');
            expect((await reloaded.list()).map(item => item.id)).to.deep.equal(['session-c']);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
