'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { Nlp } = require('@nlpjs/nlp');
const { LangDe } = require('@nlpjs/lang-de');
const { LangEn } = require('@nlpjs/lang-en');

async function run() {
    const manager = new Nlp({ languages: ['de', 'en'], autoSave: false, forceNER: false, nlu: { log: false } });
    manager.use(LangDe);
    manager.use(LangEn);
    for (const intent of workerData.intents) {
        if (!intent.enabled) {
            continue;
        }
        for (const language of workerData.languages) {
            for (const utterance of intent.utterances[language] || []) {
                manager.addDocument(language, utterance, intent.id);
            }
        }
    }
    await manager.train();
    const results = [];
    for (const item of workerData.regression) {
        const output = await manager.process(item.language, item.text);
        const actual = output.intent === 'None' ? null : output.intent;
        results.push({ ...item, actual, confidence: output.score || 0, passed: actual === item.intent });
    }
    parentPort.postMessage({ model: manager.export(true), results });
}

run().catch(error => parentPort.postMessage({ error: String((error && error.stack) || error) }));
