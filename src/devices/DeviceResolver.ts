import type { Language } from '../types/api';
import type { ActionKind, Capability, DeviceRecord } from './types';

export interface DeviceCatalogView {
    list(): DeviceRecord[];
    isAllowed(deviceId: string, capability: Capability, action: ActionKind): boolean;
}

export interface Candidate {
    deviceId: string;
    score: number;
    reasons: string[];
}

export interface Resolution {
    selected?: Candidate;
    candidates: Candidate[];
    clarification: boolean;
}

function normalize(value: string): string {
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

function matchScore(text: string, value: string): number {
    const normalized = normalize(value);
    if (!normalized) {
        return 0;
    }
    if (` ${text} `.includes(` ${normalized} `)) {
        return 100;
    }
    if (normalized.length < 5) {
        return 0;
    }
    const words = text.split(' ');
    const count = normalized.split(' ').length;
    let best = Infinity;
    for (let index = 0; index <= words.length - count; index++) {
        best = Math.min(best, distance(words.slice(index, index + count).join(' '), normalized));
    }
    return best <= 2 ? 75 - best * 10 : 0;
}

function hasApprovedAction(device: DeviceRecord, action: ActionKind, registry: DeviceCatalogView): boolean {
    return device.discoveredCapabilities.some(capability => registry.isAllowed(device.id, capability, action));
}

export class DeviceResolver {
    public constructor(private readonly registry: DeviceCatalogView) {}

    public resolve(text: string, language: Language, action: ActionKind): Resolution {
        const normalized = normalize(text);
        const candidates: Candidate[] = [];
        for (const device of this.registry.list()) {
            if (!hasApprovedAction(device, action, this.registry)) {
                continue;
            }
            const names = [device.displayName, ...(device.aliases[language] ?? [])];
            let score = 0;
            const reasons: string[] = [];
            for (const name of names) {
                const value = matchScore(normalized, name);
                if (value > score) {
                    score = value + (device.aliases[language]?.includes(name) ? 5 : 0);
                    reasons.length = 0;
                    reasons.push(value === 100 ? 'exact name or alias' : 'fuzzy name');
                }
            }
            if (!score) {
                continue;
            }
            if (device.roomIds.some(id => normalized.includes(normalize(id.split('.').at(-1) ?? '')))) {
                score += 15;
                reasons.push('room');
            }
            candidates.push({ deviceId: device.id, score, reasons });
        }
        candidates.sort((a, b) => b.score - a.score || a.deviceId.localeCompare(b.deviceId));
        const selected =
            candidates[0]?.score >= 65 && (!candidates[1] || candidates[0].score - candidates[1].score > 10)
                ? candidates[0]
                : undefined;
        return { selected, candidates, clarification: !selected };
    }
}
