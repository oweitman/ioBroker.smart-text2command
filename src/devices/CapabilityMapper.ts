import { createHash } from 'node:crypto';
import type { Capability, CapabilityKind, ObjectSnapshot } from './types';

const criticalRole = /lock|alarm|garage|door|gate|security|schloss|tor/i;
export function capabilityFingerprint(capability: Omit<Capability, 'fingerprint' | 'needsReview'>): string {
    const relevant = {
        kind: capability.kind,
        role: capability.role,
        stateId: capability.stateId,
        readStateId: capability.readStateId,
        readable: capability.readable,
        writable: capability.writable,
        valueKind: capability.valueKind,
        min: capability.min,
        max: capability.max,
        unit: capability.unit,
        enumValues: capability.enumValues,
        mapping: capability.mapping,
    };
    return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

function finish(capability: Omit<Capability, 'fingerprint' | 'needsReview'>): Capability {
    return { ...capability, fingerprint: capabilityFingerprint(capability), needsReview: false };
}

function enumValues(states: ObjectSnapshot['common']['states']): Array<string | number> | undefined {
    if (!states) {
        return undefined;
    }
    const keys = typeof states === 'string' ? states.split(';').map(part => part.split(':')[0]) : Object.keys(states);
    return keys.map(key => (Number.isNaN(Number(key)) ? key : Number(key)));
}
export function mapCapability(object: ObjectSnapshot): Capability | undefined {
    if (object.type !== 'state') {
        return undefined;
    }
    const common = object.common;
    const role = common.role ?? '';
    if (criticalRole.test(role) || criticalRole.test(object.id)) {
        return undefined;
    }
    const valueKind = common.type;
    if (valueKind !== 'boolean' && valueKind !== 'number' && valueKind !== 'string') {
        return undefined;
    }
    const aliasId = common.alias?.id;
    const writeTarget = typeof aliasId === 'string' ? aliasId : aliasId?.write;
    const readTarget = typeof aliasId === 'string' ? aliasId : aliasId?.read;
    // Alias targets cannot be verified from the alias object alone.
    if (writeTarget || readTarget) {
        return undefined;
    }

    let kind: CapabilityKind | undefined;
    if ((role === 'button' || role.startsWith('button.')) && valueKind === 'boolean' && common.write === true) {
        kind = 'button';
    } else if (role === 'switch' && valueKind === 'boolean' && common.write === true) {
        kind = 'onOff';
    } else if (
        (role === 'value' || role.startsWith('value.') || role === 'level' || role.startsWith('level.')) &&
        (valueKind === 'number' || common.read === true) &&
        (common.read === true || common.write === true)
    ) {
        kind = 'genericValue';
    }
    // Directional blind commands need separate semantics; numeric positions use generic values.
    if (!kind) {
        return undefined;
    }
    const candidate: Omit<Capability, 'fingerprint' | 'needsReview'> = {
        kind,
        ...(kind === 'genericValue' || kind === 'button' ? { role } : {}),
        ...(common.name ? { name: common.name } : {}),
        stateId: object.id,
        readable: common.read === true,
        writable: common.write === true,
        valueKind,
        min: common.min,
        max: common.max,
        unit: common.unit,
        enumValues: enumValues(common.states),
        mapping: kind === 'onOff' ? { on: true, off: false } : undefined,
    };
    return finish(candidate);
}
