import { expect } from 'chai';
import { discoverDevices } from '../src/devices/DeviceDiscovery';
import { DeviceRegistry } from '../src/devices/DeviceRegistry';
import type { ObjectSnapshot } from '../src/devices/types';

const base: ObjectSnapshot[] = [
    { id: 'lamp.0.room', type: 'device', common: { name: 'Stehlampe' } },
    {
        id: 'lamp.0.room.POWER',
        type: 'state',
        common: { name: 'Power', role: 'switch', type: 'boolean', read: true, write: true },
    },
    { id: 'enum.rooms.living', type: 'enum', common: { members: ['lamp.0.room'] } },
];

describe('device discovery and approvals', () => {
    it('discovers a device and keeps it disabled by default', () => {
        const devices = discoverDevices(base);
        expect(devices).to.have.length(1);
        expect(devices[0].roomIds).to.deep.equal(['enum.rooms.living']);
        const registry = new DeviceRegistry();
        registry.reconcile(devices);
        expect(registry.isAllowed(devices[0].id, devices[0].discoveredCapabilities[0], 'turnOn')).to.equal(false);
    });

    it('requires an exact approved fingerprint and reapproval after a mapping change', () => {
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices(base));
        const id = 'lamp.0.room';
        const stateId = 'lamp.0.room.POWER';
        registry.approve(id, stateId, 'turnOn');
        expect(registry.isAllowed(id, registry.list()[0].discoveredCapabilities[0], 'turnOn')).to.equal(false);
        registry.setEnabled(id, true);
        expect(registry.isAllowed(id, registry.list()[0].discoveredCapabilities[0], 'turnOn')).to.equal(true);
        expect(registry.isAllowed(id, registry.list()[0].discoveredCapabilities[0], 'turnOff')).to.equal(false);
        const changed = base.map(item =>
            item.id === stateId
                ? { ...item, common: { ...item.common, type: 'number', role: 'level.dimmer', min: 0, max: 100 } }
                : item,
        );
        registry.reconcile(discoverDevices(changed));
        expect(registry.list()[0].status).to.equal('needsReview');
        expect(registry.isAllowed(id, registry.list()[0].discoveredCapabilities[0], 'setLevel')).to.equal(false);
        registry.approve(id, stateId, 'setLevel');
        expect(registry.isAllowed(id, registry.list()[0].discoveredCapabilities[0], 'setLevel')).to.equal(true);
    });

    it('keeps approval after name and room changes but blocks missing devices', () => {
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices(base));
        registry.setEnabled('lamp.0.room', true);
        registry.approve('lamp.0.room', 'lamp.0.room.POWER', 'turnOn');
        registry.setAliases('lamp.0.room', { de: ['Wohnzimmerlampe'] });
        const renamed = base.map(item =>
            item.id === 'lamp.0.room' ? { ...item, common: { ...item.common, name: 'Neue Lampe' } } : item,
        );
        registry.reconcile(discoverDevices(renamed));
        expect(registry.list()[0].aliases.de).to.deep.equal(['Wohnzimmerlampe']);
        expect(registry.isAllowed('lamp.0.room', registry.list()[0].discoveredCapabilities[0], 'turnOn')).to.equal(
            true,
        );
        registry.reconcile([]);
        expect(registry.list()[0].status).to.equal('missing');
        expect(registry.isAllowed('lamp.0.room', registry.list()[0].discoveredCapabilities[0], 'turnOn')).to.equal(
            false,
        );
    });

    it('does not map a measured temperature, critical role or unresolved alias to a write action', () => {
        const objects: ObjectSnapshot[] = [
            {
                id: 'sensor.0.TEMP',
                type: 'state',
                common: { role: 'level.temperature', type: 'number', read: true, write: false },
            },
            {
                id: 'door.0.LOCK',
                type: 'state',
                common: { role: 'switch.lock', type: 'boolean', read: true, write: true },
            },
            {
                id: 'alias.0.LAMP',
                type: 'state',
                common: {
                    role: 'switch',
                    type: 'boolean',
                    read: true,
                    write: true,
                    alias: { id: 'lamp.0.room.POWER' },
                },
            },
        ];
        const devices = discoverDevices(objects);
        expect(devices).to.have.length(3);
        const temperature = devices.find(device => device.id === 'sensor.0.TEMP');
        expect(temperature?.discoveredCapabilities[0].kind).to.equal('readTemperature');
        expect(temperature?.discoveredCapabilities[0].writable).to.equal(false);
        expect(devices.filter(device => device.status === 'needsReview')).to.have.length(2);
        expect(
            devices
                .filter(device => device.status === 'needsReview')
                .every(device => device.discoveredCapabilities.length === 0),
        ).to.equal(true);
    });

    it('requires review for unknown roles and blocks critical function enums', () => {
        const devices = discoverDevices([
            {
                id: 'special.0.MODE',
                type: 'state',
                common: { role: 'mystery', type: 'string', read: true, write: true },
            },
            {
                id: 'secure.0.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            { id: 'enum.functions.alarm', type: 'enum', common: { members: ['secure.0.POWER'] } },
        ]);
        expect(devices).to.have.length(2);
        expect(devices.every(device => device.status === 'needsReview')).to.equal(true);
        expect(devices.every(device => device.discoveredCapabilities.length === 0)).to.equal(true);
    });

    it('lists a device object without known state roles as disabled', () => {
        const devices = discoverDevices([
            { id: 'unsupported.0.device', type: 'device', common: { name: 'Unbekannt' } },
        ]);
        expect(devices).to.have.length(1);
        expect(devices[0].enabled).to.equal(false);
        expect(devices[0].status).to.equal('needsReview');
        expect(devices[0].discoveredCapabilities).to.be.empty;
    });
});
