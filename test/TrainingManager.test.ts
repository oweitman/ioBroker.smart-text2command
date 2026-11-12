import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRepository } from '../src/nlp/ModelRepository';
import { TrainingManager } from '../src/nlp/TrainingManager';
import { systemIntents } from '../src/nlp/TrainingData';

describe('NLP model training and persistence', function () {
    this.timeout(120_000);

    it('trains both languages, reloads the model, and retains it after failed regression', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'smart-text2command-model-'));
        try {
            const repository = new ModelRepository(dir);
            const manager = new TrainingManager(repository);
            const trained = await manager.loadOrTrain();
            expect(trained.metadata.regressionPassed).to.equal(trained.metadata.regressionTotal);
            expect((await trained.engine.analyze('Schalte die Lampe ein', 'de')).intent).to.equal('device.turnOn');
            expect((await trained.engine.analyze('Turn off the lamp', 'en')).intent).to.equal('device.turnOff');
            for (const [text, language] of [
                ['Könntest du freundlicherweise die Leuchte im Wohnzimmer deaktivieren', 'de'],
                ['Could you kindly deactivate the light in the living room', 'en'],
            ] as const) {
                const result = await trained.engine.analyze(text, language);
                expect(result.intent).to.equal('device.turnOff');
                expect(result.confidence).to.be.at.least(0.65);
                expect(
                    result.confidence -
                        (result.alternatives.find(item => item.intent !== result.intent)?.confidence ?? 0),
                ).to.be.at.least(0.12);
            }
            for (const [text, language] of [
                ['Welche Temperatur', 'de'],
                ['What temperature', 'en'],
                ['Welche Temperatur hat die Heizung im Wohnzimmer', 'de'],
                ['What temperature does the heater in the living room have', 'en'],
            ] as const) {
                const result = await trained.engine.analyze(text, language);
                expect(result.intent).to.equal('device.getValue');
                expect(result.confidence).to.be.at.least(0.65);
                expect(
                    result.confidence -
                        (result.alternatives.find(item => item.intent !== result.intent)?.confidence ?? 0),
                ).to.be.at.least(0.12);
            }
            for (const [text, language] of [
                ['Stelle den Rollladen im Wohnzimmer auf 25 Prozent', 'de'],
                ['Stelle die Lamellen im Wohnzimmer auf 75 Prozent', 'de'],
                ['Stelle die Stellung auf 65 Prozent', 'de'],
                ['Set the blind in the living room to 25 percent', 'en'],
                ['Set the slats in the living room to 75 percent', 'en'],
                ['Set the position to 35 percent', 'en'],
            ] as const) {
                const result = await trained.engine.analyze(text, language);
                expect(result.intent).to.equal('device.setValue');
                expect(result.confidence).to.be.at.least(0.65);
                expect(
                    result.confidence -
                        (result.alternatives.find(item => item.intent !== result.intent)?.confidence ?? 0),
                ).to.be.at.least(0.12);
            }
            const loaded = await manager.loadOrTrain();
            expect(loaded.metadata.version).to.equal(trained.metadata.version);
            const updatedIntents = systemIntents();
            updatedIntents
                .find(intent => intent.id === 'device.setTemperature')!
                .utterances.de!.push('Schreibe den Thermostat Sollwert auf 22 Grad');
            const refreshed = await manager.loadOrTrain(updatedIntents);
            expect(refreshed.metadata.version).not.to.equal(trained.metadata.version);
            try {
                await manager.train(systemIntents(), [
                    { language: 'de', text: 'Schalte die Lampe ein', intent: 'device.turnOff' },
                ]);
                expect.fail('bad regression unexpectedly passed');
            } catch (error) {
                expect(String(error)).to.contain('Model regression failed');
            }
            expect((await repository.loadActive())?.metadata.version).to.equal(refreshed.metadata.version);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
