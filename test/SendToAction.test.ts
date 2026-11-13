import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandController } from '../src/commands/CommandController';
import { DeviceRegistry } from '../src/devices/DeviceRegistry';
import type { DeviceIO } from '../src/commands/types';
import type { NlpEngine } from '../src/nlp/NlpEngine';
import { NlpJsProvider } from '../src/nlp/NlpJsProvider';
import { systemIntents } from '../src/nlp/TrainingData';
import type { IntentDefinition, SendToIntentAction } from '../src/nlp/types';
import { extractParameters, fillPayload, validateSendToAction } from '../src/nlp/SendToAction';
import { IntentRepository } from '../src/nlp/IntentRepository';
import { AuditRepository } from '../src/storage/AuditRepository';

describe('configured sendTo intent', () => {
    const action: SendToIntentAction = {
        kind: 'sendTo',
        instance: 'javascript.0',
        command: 'toScript',
        payloadTemplate: {
            script: 'script.js.common.Target',
            message: 'run',
            data: { value: { $param: 'wert' }, text: { $param: 'text' } },
        },
        parameters: [
            { name: 'wert', type: 'number', prompt: { de: 'Welcher Wert?', en: 'Which value?' } },
            { name: 'text', type: 'string', prompt: { de: 'Welcher Text?', en: 'Which text?' } },
        ],
        extractionPatterns: {
            de: ['Sende Wert {wert} mit Text {text}'],
            en: ['Send value {wert} with text {text}'],
        },
    };
    const intent: IntentDefinition = {
        id: 'sendValue',
        source: 'user',
        enabled: true,
        utterances: { de: ['Sende Wert', 'Übermittle Wert'], en: ['Send value', 'Transmit value'] },
        action,
    };

    it('validates placeholders and substitutes typed values without changing the template', () => {
        validateSendToAction(action);
        expect(extractParameters(action, 'Sende Wert 42,5 mit Text Hallo Welt', 'de')).to.deep.equal({
            wert: 42.5,
            text: 'Hallo Welt',
        });
        expect(extractParameters(action, 'Send value 42.5 with text Hello world', 'en')).to.deep.equal({
            wert: 42.5,
            text: 'Hello world',
        });
        const payload = fillPayload(action.payloadTemplate, { wert: 42.5, text: 'Hello' });
        expect(payload).to.deep.equal({
            script: 'script.js.common.Target',
            message: 'run',
            data: { value: 42.5, text: 'Hello' },
        });
        expect((action.payloadTemplate as { data: { value: unknown } }).data.value).to.deep.equal({ $param: 'wert' });
        expect(() => validateSendToAction({ ...action, payloadTemplate: { value: { $param: 'unknown' } } })).to.throw();
        expect(() =>
            validateSendToAction({ ...action, parameters: [...action.parameters, action.parameters[0]] }),
        ).to.throw();
    });

    it('rejects invalid actions before persistence', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'sendto-intent-'));
        try {
            const repository = new IntentRepository(join(directory, 'intents.json'));
            await repository.save([intent]);
            expect((await repository.load())[0].action).to.deep.equal(action);
            try {
                await repository.save([{ ...intent, action: { ...action, instance: 'not-an-instance' } }]);
                expect.fail('Invalid target saved');
            } catch (error) {
                expect(String(error)).to.contain('Invalid sendTo instance');
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('uses training examples alone for a fixed JSON message', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'sendto-fixed-'));
        try {
            const fixedAction: SendToIntentAction = {
                kind: 'sendTo',
                instance: 'javascript.0',
                command: 'toScript',
                payloadTemplate: {
                    script: 'script.js.testsendto',
                    message: 'meinBefehl',
                    data: { wert: 42, text: 'Hallo' },
                },
                parameters: [],
            };
            validateSendToAction(fixedAction);
            const fixedIntent: IntentDefinition = { ...intent, id: 'fixedMessage', action: fixedAction };
            const sent: unknown[] = [];
            const model: NlpEngine = {
                load: () => Promise.resolve(),
                train: () => Promise.resolve(''),
                analyze: () =>
                    Promise.resolve({
                        intent: fixedIntent.id,
                        confidence: 0.98,
                        entities: [],
                        alternatives: [{ intent: fixedIntent.id, confidence: 0.98 }],
                    }),
            };
            const io: DeviceIO = {
                getObject: () => Promise.resolve(undefined),
                getState: () => Promise.resolve(undefined),
                setState: () => Promise.resolve(),
            };
            const controller = new CommandController(
                new DeviceRegistry(),
                io,
                () => ({ engine: model }),
                () => [fixedIntent],
                new AuditRepository(join(directory, 'audit.json')),
                'de',
                undefined,
                (instance, command, payload) => {
                    sent.push({ instance, command, payload });
                    return Promise.resolve({ version: 1, status: 'success', text: 'Erledigt.' });
                },
            );
            const analyzed = await controller.process(
                { requestId: 'fixed-analyze', text: 'Sende Wert', mode: 'analyze' },
                'caller',
            );
            expect(analyzed.status).to.equal('success');
            expect(sent).to.be.empty;
            const executed = await controller.process(
                { requestId: 'fixed-execute', text: 'Sende Wert', mode: 'execute' },
                'caller',
            );
            expect(executed).to.include({ status: 'success', response: 'Erledigt.' });
            expect(sent).to.deep.equal([
                { instance: 'javascript.0', command: 'toScript', payload: fixedAction.payloadTemplate },
            ]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('runs a fixed sendTo intent through the trained NLP model', async function () {
        this.timeout(120_000);
        const directory = await mkdtemp(join(tmpdir(), 'sendto-trained-'));
        try {
            const fixedIntent: IntentDefinition = {
                ...intent,
                id: 'testSendTo',
                utterances: {
                    de: ['Sende die Testnachricht', 'Starte den Testaufruf'],
                    en: ['Send the test message', 'Start the test call'],
                },
                action: {
                    kind: 'sendTo',
                    instance: 'javascript.0',
                    command: 'toScript',
                    payloadTemplate: {
                        script: 'script.js.testsendto',
                        message: 'meinBefehl',
                        data: { wert: 42, text: 'Hallo' },
                    },
                    parameters: [],
                },
            };
            const provider = new NlpJsProvider();
            await provider.train([...systemIntents(), fixedIntent], ['de', 'en']);
            const failures: unknown[] = [];
            const sent: unknown[] = [];
            const controller = new CommandController(
                new DeviceRegistry(),
                {
                    getObject: () => Promise.resolve(undefined),
                    getState: () => Promise.resolve(undefined),
                    setState: () => Promise.resolve(),
                },
                () => ({ engine: provider }),
                () => [fixedIntent],
                new AuditRepository(join(directory, 'audit.json')),
                'de',
                undefined,
                (_instance, _command, payload) => {
                    sent.push(payload);
                    return Promise.resolve({ version: 1, status: 'success', text: 'Test erfolgreich.' });
                },
                error => failures.push(error),
            );
            const result = await controller.process(
                { requestId: 'trained-sendto', text: 'Sende die Testnachricht', mode: 'execute' },
                'caller',
            );
            expect(result).to.include({ status: 'success', response: 'Test erfolgreich.' });
            expect(sent).to.deep.equal([(fixedIntent.action as SendToIntentAction).payloadTemplate]);
            expect(failures).to.be.empty;
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('reports unexpected processing errors to the adapter logger', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'sendto-error-log-'));
        try {
            const reported: Array<{ error: unknown; requestId: string }> = [];
            const controller = new CommandController(
                new DeviceRegistry(),
                {
                    getObject: () => Promise.resolve(undefined),
                    getState: () => Promise.resolve(undefined),
                    setState: () => Promise.resolve(),
                },
                () => {
                    throw new Error('model fixture failed');
                },
                () => [],
                new AuditRepository(join(directory, 'audit.json')),
                'de',
                undefined,
                undefined,
                (error, requestId) => reported.push({ error, requestId }),
            );
            const result = await controller.process(
                { requestId: 'failed-command', text: 'Sende Test', mode: 'execute' },
                'caller',
            );
            expect(result.errorCode).to.equal('PROCESSING_ERROR');
            expect(reported).to.have.length(1);
            expect(reported[0].requestId).to.equal('failed-command');
            expect(String(reported[0].error)).to.contain('model fixture failed');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('does not send in analyze mode, continues missing parameters and uses target text', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'sendto-command-'));
        try {
            const sends: unknown[] = [];
            let targetReply: unknown = { version: 1, status: 'success', text: 'Fertig.' };
            const model: NlpEngine = {
                load: () => Promise.resolve(),
                train: () => Promise.resolve(''),
                analyze: () =>
                    Promise.resolve({
                        intent: intent.id,
                        confidence: 0.98,
                        entities: [],
                        alternatives: [{ intent: intent.id, confidence: 0.98 }],
                    }),
            };
            const io: DeviceIO = {
                getObject: () => Promise.resolve(undefined),
                getState: () => Promise.resolve(undefined),
                setState: () => Promise.resolve(),
            };
            const controller = new CommandController(
                new DeviceRegistry(),
                io,
                () => ({ engine: model, version: 'test' }),
                () => [intent],
                new AuditRepository(join(directory, 'audit.json')),
                'de',
                undefined,
                (instance, command, payload) => {
                    sends.push({ instance, command, payload });
                    return targetReply instanceof Error ? Promise.reject(targetReply) : Promise.resolve(targetReply);
                },
            );
            const analyzed = await controller.process(
                { requestId: 'analyze', text: 'Sende Wert 42 mit Text Hallo', mode: 'analyze' },
                'user-a',
            );
            expect(analyzed.status).to.equal('success');
            expect(analyzed.analysis?.sendTo?.parameters).to.deep.equal({ wert: 42, text: 'Hallo' });
            expect(sends).to.be.empty;

            const first = await controller.process(
                { requestId: 'first', sessionId: 'a', text: 'Sende Wert', mode: 'execute' },
                'user-a',
            );
            expect(first.clarification?.parameter).to.equal('wert');
            const wrongUser = await controller.process(
                {
                    requestId: 'wrong',
                    sessionId: 'a',
                    text: '42',
                    mode: 'execute',
                    clarificationId: first.clarification!.id,
                },
                'user-b',
            );
            expect(wrongUser.errorCode).to.equal('CLARIFICATION_EXPIRED');
            const second = await controller.process(
                {
                    requestId: 'second',
                    sessionId: 'a',
                    text: '42',
                    mode: 'execute',
                    clarificationId: first.clarification!.id,
                },
                'user-a',
            );
            expect(second.clarification?.parameter).to.equal('text');
            const final = await controller.process(
                {
                    requestId: 'final',
                    sessionId: 'a',
                    text: 'Hallo Welt',
                    mode: 'execute',
                    clarificationId: second.clarification!.id,
                },
                'user-a',
            );
            expect(final).to.include({ status: 'success', response: 'Fertig.' });
            expect(sends).to.have.length(1);
            expect(sends[0]).to.deep.equal({
                instance: 'javascript.0',
                command: 'toScript',
                payload: {
                    script: 'script.js.common.Target',
                    message: 'run',
                    data: { value: 42, text: 'Hallo Welt' },
                },
            });
            const wrappedReply = {
                from: 'system.adapter.javascript.0',
                command: 'toScript',
                message: { version: 1, status: 'success', text: 'Antwort aus JavaScript.' },
            };
            targetReply = wrappedReply;
            const wrapped = await controller.process(
                { requestId: 'target-wrapped', text: 'Sende Wert 6 mit Text Test', mode: 'execute' },
                'user-a',
                true,
            );
            expect(wrapped).to.include({ status: 'success', response: 'Antwort aus JavaScript.' });
            expect(wrapped.analysis?.sendTo?.rawCallback).to.deep.equal(wrappedReply);
            expect(wrapped.analysis?.sendTo?.message).to.deep.equal(wrappedReply.message);
            targetReply = { version: 1, status: 'error', text: 'Befehl abgelehnt.' };
            const failed = await controller.process(
                { requestId: 'target-error', text: 'Sende Wert 7 mit Text Test', mode: 'execute' },
                'user-a',
            );
            expect(failed).to.include({
                status: 'error',
                response: 'Befehl abgelehnt.',
                errorCode: 'SENDTO_TARGET_ERROR',
            });
            targetReply = { version: 2, status: 'success', text: 'Unbekannte Version' };
            const invalid = await controller.process(
                { requestId: 'target-invalid', text: 'Sende Wert 8 mit Text Test', mode: 'execute' },
                'user-a',
                true,
            );
            expect(invalid).to.include({ status: 'error', errorCode: 'SENDTO_INVALID_RESPONSE' });
            expect(invalid.analysis?.sendTo?.rawCallback).to.deep.equal(targetReply);
            expect(invalid.analysis?.sendTo?.message).to.deep.equal(targetReply);
            targetReply = new Error('SENDTO_TIMEOUT');
            const timeout = await controller.process(
                { requestId: 'target-timeout', text: 'Sende Wert 9 mit Text Test', mode: 'execute' },
                'user-a',
                true,
            );
            expect(timeout).to.include({ status: 'error', errorCode: 'SENDTO_FAILED' });
            expect(timeout.analysis?.sendTo?.transportError).to.equal('SENDTO_TIMEOUT');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
