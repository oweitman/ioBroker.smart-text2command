import type { Language } from '../types/api';
import { languageRules } from '../i18n/LanguageConfig';

export interface ParsedEntity {
    type: 'number' | 'percent' | 'temperature' | 'room' | 'devicePhrase' | 'negation';
    value: string | number;
    start: number;
    end: number;
}

export interface ParsedText {
    entities: ParsedEntity[];
    negated: boolean;
    unsupported: Array<'group' | 'exception' | 'time' | 'multipleActions' | 'unit'>;
}

export function parseEntities(text: string, language: Language, rooms: string[] = []): ParsedText {
    const rules = languageRules(language);
    const entities: ParsedEntity[] = [];
    const unsupported: ParsedText['unsupported'] = [];
    const addUnsupported = (kind: ParsedText['unsupported'][number], pattern: RegExp): void => {
        if (pattern.test(text)) {
            unsupported.push(kind);
        }
    };
    for (const kind of ['group', 'exception', 'time', 'multipleActions', 'unit'] as const) {
        addUnsupported(kind, new RegExp(rules.unsupported[kind], 'iu'));
    }
    const actionVerbs = new RegExp(rules.actionVerbs, 'giu');
    if ([...text.matchAll(actionVerbs)].length > 1 && !unsupported.includes('multipleActions')) {
        unsupported.push('multipleActions');
    }
    const negation = new RegExp(rules.negation, 'giu');
    for (const match of text.matchAll(negation)) {
        entities.push({ type: 'negation', value: match[0], start: match.index, end: match.index + match[0].length });
    }
    const numeric = new RegExp(rules.numeric, 'giu');
    for (const match of text.matchAll(numeric)) {
        const raw = match[0];
        const number = Number(raw.match(/[-+]?\d+(?:[.,]\d+)?/)![0].replace(',', '.'));
        if (!Number.isFinite(number)) {
            continue;
        }
        const type = new RegExp(rules.numericPercent, 'iu').test(raw)
            ? 'percent'
            : new RegExp(rules.numericTemperature, 'iu').test(raw)
              ? 'temperature'
              : 'number';
        entities.push({ type, value: number, start: match.index, end: match.index + raw.length });
    }
    for (const room of rooms) {
        const words = room.split(/[\s_-]+/).filter(Boolean);
        if (!words.length) {
            continue;
        }
        const pattern = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]+');
        const match = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
        if (
            match &&
            !entities.some(
                entity =>
                    entity.type === 'room' &&
                    entity.start === match.index &&
                    entity.end === match.index + match[0].length,
            )
        ) {
            entities.push({ type: 'room', value: room, start: match.index, end: match.index + match[0].length });
        }
    }
    const quoted = new RegExp(rules.quoted, 'gu');
    for (const match of text.matchAll(quoted)) {
        entities.push({
            type: 'devicePhrase',
            value: match[1],
            start: match.index + 1,
            end: match.index + 1 + match[1].length,
        });
    }
    return {
        entities: entities.sort((a, b) => a.start - b.start),
        negated: entities.some(item => item.type === 'negation'),
        unsupported,
    };
}
