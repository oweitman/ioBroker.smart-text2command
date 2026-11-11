import { Nlp } from '@nlpjs/nlp';
import { createRequire } from 'node:module';
import type { Language } from '../types/api';
import { supportedLanguages } from '../i18n/LanguageConfig';
import type { NlpEngine } from './NlpEngine';
import type { Analysis, IntentDefinition } from './types';

function createManager(): Nlp {
    const loadPlugin = createRequire(__filename);
    const manager = new Nlp({
        languages: supportedLanguages.map(item => item.code),
        autoSave: false,
        forceNER: false,
        nlu: { log: false },
    });
    for (const item of supportedLanguages) {
        const plugin = (loadPlugin(item.nlpPackage) as Record<string, unknown>)[item.nlpExport];
        if (!plugin) {
            throw new Error(`Missing NLP language plugin: ${item.code}`);
        }
        manager.use(plugin);
    }
    return manager;
}

export class NlpJsProvider implements NlpEngine {
    private manager?: Nlp;

    public load(model: Uint8Array | string): Promise<void> {
        const manager = createManager();
        manager.import(typeof model === 'string' ? model : Buffer.from(model).toString('utf8'));
        this.manager = manager;
        return Promise.resolve();
    }

    public async train(data: IntentDefinition[], languages: Language[]): Promise<string> {
        const manager = createManager();
        for (const intent of data) {
            if (!intent.enabled) {
                continue;
            }
            for (const language of languages) {
                for (const utterance of intent.utterances[language] ?? []) {
                    manager.addDocument(language, utterance, intent.id);
                }
            }
        }
        await manager.train();
        const model = manager.export(true);
        this.manager = manager;
        return model;
    }

    public async analyze(text: string, language: Language): Promise<Analysis> {
        if (!this.manager) {
            throw new Error('NLP model is unavailable');
        }
        const result = await this.manager.process(language, text);
        const alternatives = (result.classifications ?? [])
            .map(item => ({ intent: item.intent ?? item.label ?? '', confidence: item.score ?? item.value ?? 0 }))
            .filter(item => item.intent && item.intent !== 'None')
            .sort((a, b) => b.confidence - a.confidence);
        return {
            intent: result.intent && result.intent !== 'None' ? result.intent : null,
            confidence: Number.isFinite(result.score) ? result.score! : 0,
            entities: (result.entities ?? [])
                .filter(item => !!item.entity && item.resolution?.value !== undefined)
                .map(item => ({
                    type: item.entity!,
                    value: item.resolution!.value!,
                    start: item.start,
                    end: item.end,
                })),
            alternatives,
        };
    }
}
