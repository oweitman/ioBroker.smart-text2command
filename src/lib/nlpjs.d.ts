declare module '@nlpjs/nlp' {
    export interface NlpResponse {
        intent?: string;
        score?: number;
        classifications?: Array<{ intent?: string; score?: number; label?: string; value?: number }>;
        entities?: Array<{
            entity?: string;
            resolution?: { value?: string | number };
            sourceText?: string;
            start?: number;
            end?: number;
        }>;
    }

    export class Nlp {
        constructor(settings?: Record<string, unknown>);
        use(plugin: unknown): void;
        addDocument(language: string, utterance: string, intent: string): void;
        train(): Promise<void>;
        process(language: string, text: string): Promise<NlpResponse>;
        export(minified?: boolean): string;
        import(model: string): void;
    }
}
