import { expect } from 'chai';
import { normalizeIntentDraft, parseAliases, validateIntentDraft } from '../src/shared/AdminForms';

describe('admin form validation', () => {
    it('normalizes aliases and rejects duplicates', () => {
        expect(parseAliases('Lampe, Stehlampe\nLicht')).to.deep.equal(['Lampe', 'Stehlampe', 'Licht']);
        expect(() => parseAliases('Lampe, lampe')).to.throw('Duplicate aliases');
    });

    it('requires typed action and bilingual training examples', () => {
        const draft = {
            id: 'myLamp',
            source: 'user' as const,
            enabled: true,
            utterances: { de: ['Lampe an', 'Licht an'], en: ['Lamp on', 'Turn on lamp'] },
            action: { kind: 'capability' as const, operation: 'turnOn' as const },
        };
        expect(() => validateIntentDraft(draft)).not.to.throw();
        expect(() =>
            validateIntentDraft({ ...draft, utterances: { ...draft.utterances, en: ['Lamp on'] } }),
        ).to.throw();
    });

    it('ignores empty lines and surrounding whitespace when saving intent examples', () => {
        const draft = {
            id: 'MusikAn',
            source: 'user' as const,
            enabled: true,
            utterances: {
                de: ['Mach Musik an', 'Spiele Musik', 'Starte Musik'],
                en: ['Music on\r', 'Play music\r', 'Start music\r', '  '],
            },
            action: { kind: 'capability' as const, operation: 'turnOn' as const },
        };
        expect(() => validateIntentDraft(draft)).to.throw('At least two valid en examples required');
        const normalized = normalizeIntentDraft(draft);
        expect(normalized.utterances.en).to.deep.equal(['Music on', 'Play music', 'Start music']);
        expect(() => validateIntentDraft(normalized)).not.to.throw();
    });
});
