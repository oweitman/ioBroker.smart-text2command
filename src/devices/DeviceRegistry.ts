import type { ActionKind, BooleanWordOverrides, Capability, DeviceRecord, DeviceStore } from './types';
import { capabilityFingerprint } from './CapabilityMapper';
import { profiles as defaultProfiles, validateRelativeProfile } from '../commands/RelativeValue';
import type { RelativeProfiles } from '../commands/RelativeValue';
import { validateCustomColors } from '../commands/NamedColors';
import { isSupportedLanguage } from '../i18n/LanguageConfig';

function approvalKey(action: ActionKind, stateId: string): string {
    return `${action}:${stateId}`;
}

function supports(capability: Capability, action: ActionKind): boolean {
    switch (action) {
        case 'turnOn':
        case 'turnOff':
            return capability.kind === 'onOff' && capability.writable;
        case 'setValue':
            return (
                capability.kind === 'genericValue' &&
                (capability.valueKind === 'number' || capability.valueKind === 'string') &&
                capability.writable
            );
        case 'press':
            return capability.kind === 'button' && capability.valueKind === 'boolean' && capability.writable;
        case 'getState':
            return capability.kind === 'onOff' && capability.readable;
        case 'getValue':
            return capability.kind === 'genericValue' && capability.readable;
    }
}

function copy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
export class DeviceRegistry {
    private devices = new Map<string, DeviceRecord>();
    private relativeProfiles: RelativeProfiles = {};
    private customColors: DeviceStore['customColors'] = [];
    public constructor(saved?: DeviceStore) {
        if (saved) {
            if (saved.schemaVersion !== 1 || !Array.isArray(saved.devices)) {
                throw new Error('Unsupported device store schema');
            }
            for (const device of saved.devices) {
                this.devices.set(device.id, copy(device));
            }
            this.relativeProfiles = copy(saved.relativeProfiles ?? {});
            this.customColors = copy(saved.customColors ?? []);
        }
    }
    public list(): DeviceRecord[] {
        return [...this.devices.values()].map(copy).sort((a, b) => a.id.localeCompare(b.id));
    }
    public snapshot(): DeviceStore {
        return {
            schemaVersion: 1,
            devices: this.list(),
            relativeProfiles: copy(this.relativeProfiles),
            customColors: copy(this.customColors),
        };
    }
    public getRelativeProfiles(): RelativeProfiles {
        return copy(this.relativeProfiles);
    }
    public getCustomColors(): NonNullable<DeviceStore['customColors']> {
        return copy(this.customColors ?? []);
    }
    public setRelativeProfiles(profiles: RelativeProfiles): void {
        const validated = this.validateProfiles(profiles);
        if (Object.values(validated).some(profile => profile.inverted !== undefined)) {
            throw new Error('Direction override is device-specific');
        }
        this.relativeProfiles = validated;
    }
    public setCustomColors(colors: DeviceStore['customColors']): void {
        this.customColors = validateCustomColors(colors);
    }
    public setDeviceRelativeProfiles(deviceId: string, stateId: string, profiles: RelativeProfiles): void {
        const device = this.requireDevice(deviceId);
        if (
            !device.discoveredCapabilities.some(
                capability =>
                    capability.stateId === stateId &&
                    capability.kind === 'genericValue' &&
                    capability.valueKind === 'number' &&
                    capability.readable &&
                    capability.writable,
            )
        ) {
            throw new Error('Relative capability not supported');
        }
        const validated = this.validateProfiles(profiles);
        device.relativeProfiles = { ...(device.relativeProfiles ?? {}), [stateId]: validated };
    }
    private validateProfiles(profiles: RelativeProfiles): RelativeProfiles {
        if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
            throw new Error('Invalid relative profiles');
        }
        const result: RelativeProfiles = {};
        for (const [key, value] of Object.entries(profiles)) {
            const [property, unit] = key.split(':');
            if (
                !Object.prototype.hasOwnProperty.call(
                    defaultProfiles[property as keyof typeof defaultProfiles] ?? {},
                    unit,
                )
            ) {
                throw new Error('Invalid relative profile key');
            }
            result[key] = validateRelativeProfile(value);
            const step = result[key].step;
            if (step !== undefined && (key.endsWith(':°C') ? step % 0.5 !== 0 : !Number.isInteger(step))) {
                throw new Error('Invalid relative step grid');
            }
        }
        return result;
    }
    public reconcile(discovered: DeviceRecord[]): void {
        const seen = new Set<string>();
        for (const fresh of discovered) {
            seen.add(fresh.id);
            const old = this.devices.get(fresh.id);
            if (!old) {
                this.devices.set(fresh.id, copy(fresh));
                continue;
            }
            const approvedCapabilities = { ...old.approvedCapabilities };
            const capabilities = fresh.discoveredCapabilities.map(capability => ({
                ...capability,
                needsReview: Object.entries(approvedCapabilities).some(
                    ([key, fingerprint]) =>
                        key.endsWith(`:${capability.stateId}`) && fingerprint !== capability.fingerprint,
                ),
            }));
            this.devices.set(fresh.id, {
                ...fresh,
                aliases: old.aliases,
                booleanWords: old.booleanWords,
                relativeProfiles: old.relativeProfiles,
                enabled: old.enabled,
                approvedCapabilities,
                discoveredCapabilities: capabilities,
                status:
                    fresh.status === 'needsReview' || capabilities.some(capability => capability.needsReview)
                        ? 'needsReview'
                        : 'available',
            });
        }
        for (const [id, old] of this.devices) {
            if (!seen.has(id)) {
                this.devices.set(id, { ...old, status: 'missing' });
            }
        }
    }
    public setEnabled(deviceId: string, enabled: boolean): void {
        const device = this.requireDevice(deviceId);
        device.enabled = enabled;
    }
    public setAliases(deviceId: string, aliases: DeviceRecord['aliases']): void {
        const device = this.requireDevice(deviceId);
        for (const values of Object.values(aliases)) {
            if (
                values &&
                (!Array.isArray(values) ||
                    values.some(value => typeof value !== 'string' || !value.trim() || value.length > 100))
            ) {
                throw new Error('Invalid aliases');
            }
        }
        device.aliases = copy(aliases);
    }
    public setBooleanWords(deviceId: string, overrides: BooleanWordOverrides): void {
        const device = this.requireDevice(deviceId);
        if (
            !overrides ||
            typeof overrides !== 'object' ||
            Array.isArray(overrides) ||
            Object.keys(overrides).length > 100
        ) {
            throw new Error('Invalid boolean words');
        }
        const cleaned: BooleanWordOverrides = {};
        for (const [stateId, translations] of Object.entries(overrides)) {
            const capability = device.discoveredCapabilities.find(item => item.stateId === stateId);
            if (
                (!capability && !device.booleanWords?.[stateId]) ||
                (capability &&
                    (capability.kind !== 'genericValue' ||
                        capability.valueKind !== 'boolean' ||
                        !capability.readable)) ||
                !translations ||
                typeof translations !== 'object' ||
                Array.isArray(translations)
            ) {
                throw new Error('Invalid boolean words');
            }
            const languages: BooleanWordOverrides[string] = {};
            for (const [code, words] of Object.entries(translations)) {
                if (
                    !isSupportedLanguage(code) ||
                    !words ||
                    typeof words !== 'object' ||
                    Array.isArray(words) ||
                    Object.keys(words).some(key => key !== 'true' && key !== 'false')
                ) {
                    throw new Error('Invalid boolean words');
                }
                const pair: Partial<Record<'true' | 'false', string>> = {};
                for (const key of ['true', 'false'] as const) {
                    const value = words[key];
                    if (value === undefined) {
                        continue;
                    }
                    if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\r\n]/.test(value)) {
                        throw new Error('Invalid boolean words');
                    }
                    pair[key] = value.trim();
                }
                if (Object.keys(pair).length) {
                    languages[code] = pair;
                }
            }
            if (Object.keys(languages).length) {
                cleaned[stateId] = languages;
            }
        }
        device.booleanWords = cleaned;
    }
    public approve(deviceId: string, stateId: string, action: ActionKind): void {
        const device = this.requireDevice(deviceId);
        if (device.status === 'missing') {
            throw new Error('Device is missing');
        }
        const capability = device.discoveredCapabilities.find(candidate => candidate.stateId === stateId);
        if (!capability) {
            throw new Error('Capability not discovered');
        }
        if (!supports(capability, action)) {
            throw new Error('Action is incompatible with capability');
        }
        for (const [key, fingerprint] of Object.entries(device.approvedCapabilities)) {
            if (key.endsWith(`:${stateId}`) && fingerprint !== capability.fingerprint) {
                delete device.approvedCapabilities[key];
            }
        }
        device.approvedCapabilities[approvalKey(action, stateId)] = capability.fingerprint;
        capability.needsReview = false;
        if (!device.discoveredCapabilities.some(item => item.needsReview)) {
            device.status = 'available';
        }
    }
    public approveMany(deviceId: string, approvals: Array<{ stateId: string; action: ActionKind }>): void {
        for (const approval of approvals) {
            this.approve(deviceId, approval.stateId, approval.action);
        }
    }
    public revoke(deviceId: string, stateId: string, action: ActionKind): void {
        const device = this.requireDevice(deviceId);
        delete device.approvedCapabilities[approvalKey(action, stateId)];
        const capability = device.discoveredCapabilities.find(candidate => candidate.stateId === stateId);
        if (capability) {
            capability.needsReview = Object.entries(device.approvedCapabilities).some(
                ([key, fingerprint]) => key.endsWith(`:${stateId}`) && fingerprint !== capability.fingerprint,
            );
        }
        if (device.status === 'needsReview' && !device.discoveredCapabilities.some(item => item.needsReview)) {
            device.status = 'available';
        }
    }
    public revokeMany(deviceId: string, revocations: Array<{ stateId: string; action: ActionKind }>): void {
        for (const revocation of revocations) {
            this.revoke(deviceId, revocation.stateId, revocation.action);
        }
    }
    public isAllowed(deviceId: string, capability: Capability, action: ActionKind): boolean {
        const device = this.devices.get(deviceId);
        return (
            !!device &&
            device.enabled &&
            device.status !== 'missing' &&
            !capability.needsReview &&
            supports(capability, action) &&
            capabilityFingerprint(capability) === capability.fingerprint &&
            device.approvedCapabilities[approvalKey(action, capability.stateId)] === capability.fingerprint &&
            device.discoveredCapabilities.some(
                item => item.stateId === capability.stateId && item.fingerprint === capability.fingerprint,
            )
        );
    }

    private requireDevice(deviceId: string): DeviceRecord {
        const device = this.devices.get(deviceId);
        if (!device) {
            throw new Error('Unknown device');
        }
        return device;
    }
}
