export interface SpokenNumberRules {
    units: Record<string, number>;
    teens: Record<string, number>;
    tens: Record<string, number>;
    unitTensJoiner?: string;
    unitTensOrder: 'unitFirst' | 'tensFirst';
    decimalMarkers: string[];
    negativeMarkers: string[];
    hundredWords?: string[];
    hundredJoiners?: string[];
    ambiguousUnits?: string[];
}

export interface SpokenNumberMatch {
    value: number;
    start: number;
    end: number;
}

interface Word {
    value: string;
    start: number;
    end: number;
    separator: string;
}

function connected(words: Word[], previous: number): boolean {
    return /^[\s-]+$/.test(words[previous + 1]?.separator ?? '');
}

function lookup(values: Record<string, number>, word: string | undefined): number | undefined {
    return word !== undefined && Object.hasOwn(values, word) ? values[word] : undefined;
}

function atomic(word: string, rules: SpokenNumberRules): number | undefined {
    const direct = lookup(rules.units, word) ?? lookup(rules.teens, word) ?? lookup(rules.tens, word);
    if (direct !== undefined) {
        return direct;
    }
    if (rules.unitTensOrder === 'unitFirst' && rules.unitTensJoiner) {
        for (const [unit, value] of Object.entries(rules.units)) {
            if (value < 1 || value > 9) {
                continue;
            }
            for (const [ten, tensValue] of Object.entries(rules.tens)) {
                if (word === `${unit}${rules.unitTensJoiner}${ten}`) {
                    return tensValue + value;
                }
            }
        }
    }
    for (const scale of rules.hundredWords ?? []) {
        const position = word.indexOf(scale);
        if (position < 0) {
            continue;
        }
        const before = word.slice(0, position);
        const after = word.slice(position + scale.length);
        const multiplier = before ? atomic(before, rules) : 1;
        const remainder = after ? atomic(after, rules) : 0;
        if (
            multiplier !== undefined &&
            multiplier >= 1 &&
            multiplier <= 9 &&
            remainder !== undefined &&
            remainder < 100
        ) {
            return multiplier * 100 + remainder;
        }
    }
    return undefined;
}

function integerAt(words: Word[], index: number, rules: SpokenNumberRules): { value: number; end: number } | undefined {
    const word = words[index]?.value;
    if (!word) {
        return undefined;
    }
    const value = atomic(word, rules);
    if (value === undefined) {
        return undefined;
    }
    if (
        rules.unitTensOrder === 'unitFirst' &&
        value > 0 &&
        value < 10 &&
        connected(words, index) &&
        connected(words, index + 1) &&
        words[index + 1]?.value === rules.unitTensJoiner
    ) {
        const tens = lookup(rules.tens, words[index + 2]?.value);
        if (tens !== undefined) {
            return { value: tens + value, end: index + 3 };
        }
    }
    if (
        rules.unitTensOrder === 'tensFirst' &&
        value > 0 &&
        value < 10 &&
        connected(words, index) &&
        rules.hundredWords?.includes(words[index + 1]?.value)
    ) {
        const joined =
            connected(words, index + 1) && (rules.hundredJoiners?.includes(words[index + 2]?.value) ?? false);
        const tailIndex = index + (joined ? 3 : 2);
        const tail = connected(words, tailIndex - 1) ? integerAt(words, tailIndex, rules) : undefined;
        return tail && tail.value < 100
            ? { value: value * 100 + tail.value, end: tail.end }
            : { value: value * 100, end: index + 2 };
    }
    if (rules.unitTensOrder === 'tensFirst' && value >= 20 && value % 10 === 0 && connected(words, index)) {
        const next = words[index + 1];
        const unit = lookup(rules.units, next?.value);
        if (unit !== undefined && unit > 0 && unit < 10) {
            return { value: value + unit, end: index + 2 };
        }
    }
    return { value, end: index + 1 };
}

function wordsIn(text: string): Word[] {
    let previousEnd = 0;
    return [...text.matchAll(/\p{L}+/gu)].map(match => {
        const word = {
            value: match[0].toLocaleLowerCase(),
            start: match.index,
            end: match.index + match[0].length,
            separator: text.slice(previousEnd, match.index),
        };
        previousEnd = word.end;
        return word;
    });
}

function numberAt(words: Word[], index: number, rules: SpokenNumberRules): { value: number; end: number } | undefined {
    const negative = rules.negativeMarkers.includes(words[index]?.value);
    const start = negative ? index + 1 : index;
    const integer = integerAt(words, start, rules);
    if (!integer) {
        return undefined;
    }
    let end = integer.end;
    let value = integer.value;
    if (connected(words, end - 1) && rules.decimalMarkers.includes(words[end]?.value)) {
        let cursor = end + 1;
        let digits = '';
        while (cursor < words.length && connected(words, cursor - 1)) {
            const fraction = integerAt(words, cursor, rules);
            if (!fraction || fraction.value > 99) {
                break;
            }
            digits += String(fraction.value);
            cursor = fraction.end;
        }
        if (digits) {
            value += Number(`0.${digits}`);
            end = cursor;
        }
    }
    return { value: negative ? -value : value, end };
}

export function findSpokenNumbers(text: string, rules: SpokenNumberRules): SpokenNumberMatch[] {
    const words = wordsIn(text);
    const matches: SpokenNumberMatch[] = [];
    for (let index = 0; index < words.length;) {
        const parsed = numberAt(words, index, rules);
        if (!parsed) {
            index++;
            continue;
        }
        const start = words[index].start;
        const end = words[parsed.end - 1].end;
        const standaloneAmbiguous = parsed.end === index + 1 && rules.ambiguousUnits?.includes(words[index].value);
        if (!standaloneAmbiguous) {
            matches.push({ value: parsed.value, start, end });
        }
        index = parsed.end;
    }
    return matches;
}

export function parseSpokenNumber(text: string, rules: SpokenNumberRules): number | undefined {
    const trimmed = text.trim();
    const matches = findSpokenNumbers(trimmed, { ...rules, ambiguousUnits: [] });
    return matches.length === 1 && matches[0].start === 0 && matches[0].end === trimmed.length
        ? matches[0].value
        : undefined;
}
