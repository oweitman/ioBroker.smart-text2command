import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import nlpPackage from '@nlpjs/nlp/package.json';
import { NlpJsProvider } from './NlpJsProvider';
import type { ModelRepository, ModelMetadata } from './ModelRepository';
import { regressionCases, systemIntents } from './TrainingData';
import type { IntentDefinition, RegressionCase } from './types';
import { supportedLanguages } from '../i18n/LanguageConfig';

interface WorkerResult {
    model?: string;
    error?: string;
    results?: Array<RegressionCase & { actual: string | null; confidence: number; passed: boolean }>;
}

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function trainingHash(intents: IntentDefinition[]): string {
    return hash(JSON.stringify(intents));
}

export class TrainingManager {
    private running = false;

    public constructor(private readonly repository: ModelRepository) {}

    public async loadOrTrain(
        intents: IntentDefinition[] = systemIntents(),
    ): Promise<{ engine: NlpJsProvider; metadata: ModelMetadata }> {
        const existing = await this.repository.loadActive();
        if (existing?.metadata.trainingHash === trainingHash(intents)) {
            const engine = new NlpJsProvider();
            await engine.load(existing.model);
            return { engine, metadata: existing.metadata };
        }
        return this.train(intents);
    }

    public async train(
        intents: IntentDefinition[],
        regression: RegressionCase[] = regressionCases(),
    ): Promise<{ engine: NlpJsProvider; metadata: ModelMetadata }> {
        if (this.running) {
            throw new Error('Training already running');
        }
        this.running = true;
        try {
            this.validateIntents(intents);
            const result = await this.runWorker(intents, regression);
            if (!result.model || !result.results || result.results.length !== regression.length) {
                throw new Error(result.error ?? 'Training worker returned no model');
            }
            const failures = result.results.filter(item => !item.passed);
            if (failures.length) {
                throw new Error(
                    `Model regression failed: ${failures.map(item => `${item.language}:${item.text} -> ${item.actual}`).join('; ')}`,
                );
            }
            const engine = new NlpJsProvider();
            await engine.load(result.model);
            const metadata: ModelMetadata = {
                version: hash(result.model).slice(0, 16),
                trainingHash: trainingHash(intents),
                engineVersion: nlpPackage.version,
                trainedAt: new Date().toISOString(),
                regressionPassed: result.results.length,
                regressionTotal: regression.length,
            };
            await this.repository.activate(result.model, metadata);
            return { engine, metadata };
        } finally {
            this.running = false;
        }
    }

    private validateIntents(intents: IntentDefinition[]): void {
        const ids = new Set<string>();
        for (const intent of intents) {
            if (!/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(intent.id) || ids.has(intent.id)) {
                throw new Error('Invalid intent ID');
            }
            ids.add(intent.id);
            if (intent.source !== 'system' && intent.source !== 'user') {
                throw new Error('Invalid intent source');
            }
            if (intent.source === 'user' && (intent.id.startsWith('device.') || intent.id === 'None')) {
                throw new Error('Reserved intent ID');
            }
            for (const { code: language } of supportedLanguages) {
                const examples = intent.utterances[language] ?? [];
                if (
                    !Array.isArray(examples) ||
                    examples.some(text => typeof text !== 'string' || !text.trim() || text.length > 1000)
                ) {
                    throw new Error('Invalid utterance');
                }
            }
        }
    }

    private runWorker(intents: IntentDefinition[], regression: RegressionCase[]): Promise<WorkerResult> {
        return new Promise((resolve, reject) => {
            const worker = new Worker(join(__dirname, 'training-worker.js'), {
                workerData: { intents, languages: supportedLanguages.map(item => item.code), regression },
            });
            const timer = setTimeout(() => {
                void worker.terminate();
                reject(new Error('Training timed out'));
            }, 120_000);
            worker.once('message', (result: WorkerResult) => {
                clearTimeout(timer);
                void worker.terminate();
                resolve(result);
            });
            worker.once('error', error => {
                clearTimeout(timer);
                reject(error);
            });
            worker.once('exit', code => {
                if (code !== 0) {
                    clearTimeout(timer);
                    reject(new Error(`Training worker exited with code ${code}`));
                }
            });
        });
    }
}
