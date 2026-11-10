import type { Language } from '../types/api';

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
    const entities: ParsedEntity[] = [];
    const unsupported: ParsedText['unsupported'] = [];
    const addUnsupported = (kind: ParsedText['unsupported'][number], pattern: RegExp): void => {
        if (pattern.test(text)) {
            unsupported.push(kind);
        }
    };
    addUnsupported('group', language === 'de' ? /\b(alle|sämtliche)\b/i : /\b(all|every)\b/i);
    addUnsupported('exception', language === 'de' ? /\b(außer|ausgenommen)\b/i : /\b(except|excluding)\b/i);
    addUnsupported(
        'time',
        language === 'de'
            ? /\b(morgen|später|um\s+\d{1,2}(?::\d{2})?\s*uhr)\b/i
            : /\b(tomorrow|later|at\s+\d{1,2}(?::\d{2})?)\b/i,
    );
    addUnsupported('multipleActions', language === 'de' ? /\b(und|danach)\b/i : /\b(and|then)\b/i);
    addUnsupported('unit', /\b(fahrenheit|kelvin)\b|°\s*[fFkK]\b/i);
    const actionVerbs =
        language === 'de'
            ? /\b(schalte|schalt|setze|setz|stelle|stell|dimme|dimm|aktiviere|deaktiviere)\b/gi
            : /\b(turn|switch|set|dim|activate|deactivate)\b/gi;
    if ([...text.matchAll(actionVerbs)].length > 1 && !unsupported.includes('multipleActions')) {
        unsupported.push('multipleActions');
    }
    const negation = language === 'de' ? /\b(nicht|kein(?:e|en|er|es)?)\b/gi : /\b(not|don't|do not|never)\b/gi;
    for (const match of text.matchAll(negation)) {
        entities.push({ type: 'negation', value: match[0], start: match.index, end: match.index + match[0].length });
    }
    const numeric = /(?<![\p{L}\d])[-+]?\d+(?:[.,]\d+)?\s*(?:%|prozent|percent|°\s*c|grad|degrees?|celsius)?/giu;
    for (const match of text.matchAll(numeric)) {
        const raw = match[0];
        const number = Number(raw.match(/[-+]?\d+(?:[.,]\d+)?/)![0].replace(',', '.'));
        if (!Number.isFinite(number)) {
            continue;
        }
        const type = /%|prozent|percent/i.test(raw)
            ? 'percent'
            : /°\s*c|grad|degree|celsius/i.test(raw)
              ? 'temperature'
              : 'number';
        entities.push({ type, value: number, start: match.index, end: match.index + raw.length });
    }
    for (const room of rooms) {
        const index = text.toLocaleLowerCase(language).indexOf(room.toLocaleLowerCase(language));
        if (index >= 0) {
            entities.push({ type: 'room', value: room, start: index, end: index + room.length });
        }
    }
    const quoted = /["„“]([^"„“]{2,100})["„“]/g;
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
