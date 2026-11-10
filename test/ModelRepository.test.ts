import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRepository, type ModelMetadata } from '../src/nlp/ModelRepository';

describe('model version storage', () => {
    it('supports rollback and falls back from a damaged active model', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'smart-text2command-model-repo-'));
        try {
            const repository = new ModelRepository(dir);
            const metadata = (version: string): ModelMetadata => ({
                version,
                trainingHash: 'hash',
                engineVersion: '4.27.0',
                trainedAt: new Date().toISOString(),
                regressionPassed: 2,
                regressionTotal: 2,
            });
            await repository.activate('old', metadata('aaaaaaaaaaaaaaaa'));
            await repository.activate('new', metadata('bbbbbbbbbbbbbbbb'));
            expect((await repository.loadActive())?.model).to.equal('new');
            await writeFile(join(dir, 'model-bbbbbbbbbbbbbbbb.json'), 'damaged');
            expect((await repository.loadActive())?.model).to.equal('old');
            await repository.rollback();
            expect((await repository.loadActive())?.model).to.equal('old');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
