import { mapCapability } from './CapabilityMapper';
import type { DeviceRecord, ObjectSnapshot } from './types';

function nameOf(object: ObjectSnapshot): string {
    const name = object.common.name;
    if (typeof name === 'string') {
        return name;
    }
    return name?.de ?? name?.en ?? object.id;
}

function parentFor(stateId: string, objects: Map<string, ObjectSnapshot>): string {
    let id = stateId.substring(0, stateId.lastIndexOf('.'));
    let channel: string | undefined;
    while (id) {
        const parent = objects.get(id);
        if (parent?.type === 'device') {
            return id;
        }
        if (parent?.type === 'channel' && !channel) {
            channel = id;
        }
        const dot = id.lastIndexOf('.');
        if (dot < 0) {
            break;
        }
        id = id.substring(0, dot);
    }
    return channel ?? stateId;
}

function matchesMember(member: string, objectId: string): boolean {
    return member === objectId || objectId.startsWith(`${member}.`);
}

function ancestors(id: string): string[] {
    const result = [id];
    let dot = id.lastIndexOf('.');
    while (dot >= 0) {
        id = id.substring(0, dot);
        result.push(id);
        dot = id.lastIndexOf('.');
    }
    return result;
}
export function discoverDevices(objects: ObjectSnapshot[], now = new Date().toISOString()): DeviceRecord[] {
    const byId = new Map(objects.map(object => [object.id, object]));
    const enums = objects.filter(object => object.type === 'enum');
    const devices = new Map<string, DeviceRecord>();
    for (const object of objects) {
        if (object.type !== 'state' || object.id.startsWith('system.')) {
            continue;
        }
        const capability = mapCapability(object);
        if (!capability && !object.common.role) {
            continue;
        }
        const parentId = parentFor(object.id, byId);
        const parent = byId.get(parentId) ?? object;
        const inherited = ancestors(object.id);
        const roomIds = enums
            .filter(
                item =>
                    item.id.startsWith('enum.rooms.') &&
                    item.common.members?.some(member => inherited.some(id => matchesMember(member, id))),
            )
            .map(item => item.id);
        const functionIds = enums
            .filter(
                item =>
                    item.id.startsWith('enum.functions.') &&
                    item.common.members?.some(member => inherited.some(id => matchesMember(member, id))),
            )
            .map(item => item.id);
        const critical = functionIds.some(id => /lock|alarm|garage|door|gate|security|schloss|tor/i.test(id));
        let device = devices.get(parentId);
        if (!device) {
            device = {
                id: parentId,
                sourceObjectId: parentId,
                displayName: nameOf(parent),
                roomIds,
                functionIds,
                aliases: {},
                discoveredCapabilities: [],
                approvedCapabilities: {},
                enabled: false,
                lastSeenAt: now,
                status: capability && !critical ? 'available' : 'needsReview',
            };
            devices.set(parentId, device);
        }
        device.roomIds = [...new Set([...device.roomIds, ...roomIds])];
        device.functionIds = [...new Set([...device.functionIds, ...functionIds])];
        if (capability && !critical) {
            device.discoveredCapabilities.push(capability);
        } else {
            device.status = 'needsReview';
        }
    }
    for (const object of objects) {
        if ((object.type !== 'device' && object.type !== 'channel') || object.id.startsWith('system.')) {
            continue;
        }
        if (
            object.type === 'channel' &&
            ancestors(object.id)
                .slice(1)
                .some(id => byId.get(id)?.type === 'device')
        ) {
            continue;
        }
        if (devices.has(object.id)) {
            continue;
        }
        const inherited = ancestors(object.id);
        devices.set(object.id, {
            id: object.id,
            sourceObjectId: object.id,
            displayName: nameOf(object),
            roomIds: enums
                .filter(
                    item =>
                        item.id.startsWith('enum.rooms.') &&
                        item.common.members?.some(member => inherited.some(id => matchesMember(member, id))),
                )
                .map(item => item.id),
            functionIds: enums
                .filter(
                    item =>
                        item.id.startsWith('enum.functions.') &&
                        item.common.members?.some(member => inherited.some(id => matchesMember(member, id))),
                )
                .map(item => item.id),
            aliases: {},
            discoveredCapabilities: [],
            approvedCapabilities: {},
            enabled: false,
            lastSeenAt: now,
            status: 'needsReview',
        });
    }
    return [...devices.values()];
}
