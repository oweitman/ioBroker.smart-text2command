import type { Language } from '../types/api';
import type { ActionKind, Capability, DeviceRecord } from './types';
import { inferValueDomain, matchesValueDomain } from './ValueDomain';
import type { ValueDomain } from './ValueDomain';
import { capabilityNameMatches } from './CapabilityName';
import { languageRules } from '../i18n/LanguageConfig';

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

export function roomNames(device: DeviceRecord, id: string, language: Language): string[] {
    const name = device.enumNames?.[id];
    const label = typeof name === 'string' ? name : (name?.[language] ?? Object.values(name ?? {})[0]);
    return [...new Set([id.split('.').at(-1) ?? '', label].filter(Boolean))];
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

function hasApprovedAction(
    device: DeviceRecord,
    action: ActionKind,
    registry: DeviceCatalogView,
    domain: ReturnType<typeof inferValueDomain>,
    language: Language,
): boolean {
    return device.discoveredCapabilities.some(
        capability =>
            registry.isAllowed(device.id, capability, action) && matchesValueDomain(capability, domain, language),
    );
}

export class DeviceResolver {
    public constructor(private readonly registry: DeviceCatalogView) {}

    public roomMatches(text: string, language: Language): Array<{ id: string; label: string }> {
        const normalized = normalize(text);
        const rooms = new Map<string, string>();
        for (const device of this.registry.list().filter(item => item.status !== 'missing')) {
            for (const id of device.roomIds) {
                const names = roomNames(device, id, language);
                if (names.some(name => ` ${normalized} `.includes(` ${normalize(name)} `))) {
                    rooms.set(id, names.at(-1) ?? id);
                }
            }
        }
        return [...rooms].map(([id, label]) => ({ id, label }));
    }

    public resolve(
        text: string,
        language: Language,
        action: ActionKind,
        forcedRoomId?: string,
        requestedDomain?: ValueDomain,
    ): Resolution {
        const normalized = normalize(text);
        const domain =
            requestedDomain ??
            (action === 'getValue' || action === 'setValue' ? inferValueDomain(text, language) : undefined);
        const requestedRooms = new Set(
            forcedRoomId ? [forcedRoomId] : this.roomMatches(text, language).map(room => room.id),
        );
        const explicitPhrase = new RegExp(languageRules(language).deviceBeforeRoom, 'iu').exec(text)?.groups?.device;
        const namedDevices = explicitPhrase
            ? this.registry
                  .list()
                  .filter(device =>
                      [device.displayName, ...(device.aliases[language] ?? [])].some(
                          name => matchScore(normalize(explicitPhrase), name) > 0,
                      ),
                  )
            : [];
        const namedDeviceIds = new Set(namedDevices.map(device => device.id));
        const candidates: Candidate[] = [];
        for (const device of this.registry.list()) {
            if (requestedRooms.size && !device.roomIds.some(id => requestedRooms.has(id))) {
                continue;
            }
            if (!hasApprovedAction(device, action, this.registry, domain, language)) {
                continue;
            }
            if (explicitPhrase) {
                if (namedDeviceIds.size && !namedDeviceIds.has(device.id)) {
                    continue;
                }
                if (!namedDeviceIds.size) {
                    const functionNamed = device.functionIds.some(id =>
                        [id.split('.').at(-1) ?? '', device.enumNames?.[id]]
                            .flatMap(name => (typeof name === 'string' ? [name] : Object.values(name ?? {})))
                            .some(name => matchScore(normalize(explicitPhrase), name) > 0),
                    );
                    if (!functionNamed) {
                        continue;
                    }
                }
            }
            const functionMatched = device.discoveredCapabilities.some(
                capability =>
                    this.registry.isAllowed(device.id, capability, action) &&
                    matchesValueDomain(capability, domain, language) &&
                    capabilityNameMatches(capability, text, language),
            );
            const names = [device.displayName, ...(device.aliases[language] ?? [])];
            let score = 0;
            const reasons: string[] = [];
            const roomMatched = forcedRoomId
                ? device.roomIds.includes(forcedRoomId)
                : device.roomIds.some(id =>
                      roomNames(device, id, language).some(name => {
                          const room = normalize(name);
                          return room.length > 0 && ` ${normalized} `.includes(` ${room} `);
                      }),
                  );
            for (const name of names) {
                const value = matchScore(normalized, name);
                if (value > score) {
                    score = value + (device.aliases[language]?.includes(name) ? 5 : 0);
                    reasons.length = 0;
                    reasons.push(value === 100 ? 'exact name or alias' : 'fuzzy name');
                }
            }
            if (!score) {
                if (functionMatched) {
                    score = 85;
                    reasons.push('function name');
                } else if (!roomMatched) {
                    continue;
                } else {
                    score = 65;
                    reasons.push('room');
                }
            } else if (roomMatched) {
                score += 15;
                reasons.push('room');
            }
            if (functionMatched && !reasons.includes('function name')) {
                score += 20;
                reasons.push('function name');
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
