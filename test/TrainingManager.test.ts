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
            const loaded = await manager.loadOrTrain();
            expect(loaded.metadata.version).to.equal(trained.metadata.version);
            try {
                await manager.train(systemIntents(), [
                    { language: 'de', text: 'Schalte die Lampe ein', intent: 'device.turnOff' },
                ]);
                expect.fail('bad regression unexpectedly passed');
            } catch (error) {
                expect(String(error)).to.contain('Model regression failed');
            }
            expect((await repository.loadActive())?.metadata.version).to.equal(trained.metadata.version);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
