export function normalizedName(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function distance(a: string, b: string): number {
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = previous[0];
        previous[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const old = previous[j];
            previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = old;
        }
    }
    return previous[b.length];
}

export function similarNameDistance(phrase: string, name: string): number | undefined {
    const source = normalizedName(phrase);
    const target = normalizedName(name);
    if (target.length < 5 || !source || source === target) {
        return undefined;
    }
    const words = source.split(' ');
    const count = target.split(' ').length;
    const limit = Math.min(4, Math.max(1, Math.floor(target.length * 0.3)));
    let best = Infinity;
    for (let index = 0; index <= words.length - count; index++) {
        const candidate = words.slice(index, index + count).join(' ');
        if (Math.abs(candidate.length - target.length) <= limit) {
            best = Math.min(best, distance(candidate, target));
        }
    }
    return best > 0 && best <= limit ? best : undefined;
}
