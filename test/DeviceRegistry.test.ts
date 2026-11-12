import { expect } from 'chai';
import { discoverDevices } from '../src/devices/DeviceDiscovery';
import { mapCapability } from '../src/devices/CapabilityMapper';
import { capabilityName } from '../src/devices/CapabilityName';
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
    it('discovers writable buttons as press only, without on/off or read actions', () => {
        const id = 'test.0.blind';
        const states: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Rollladen' } },
            {
                id: `${id}.AUF`,
                type: 'state',
                common: { role: 'button.open.blind', type: 'boolean', read: false, write: true },
            },
            { id: `${id}.STOP`, type: 'state', common: { role: 'button', type: 'boolean', read: false, write: true } },
            {
                id: `${id}.UNSCHREIBBAR`,
                type: 'state',
                common: { role: 'button', type: 'boolean', read: true, write: false },
            },
        ];
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices(states));
        const device = registry.list()[0];
        expect(device.discoveredCapabilities.map(item => item.stateId)).to.deep.equal([`${id}.AUF`, `${id}.STOP`]);
        expect(device.discoveredCapabilities.every(item => item.kind === 'button')).to.equal(true);
        registry.setEnabled(id, true);
        registry.approve(id, `${id}.AUF`, 'press');
        expect(registry.isAllowed(id, device.discoveredCapabilities[0], 'press')).to.equal(true);
        expect(registry.isAllowed(id, device.discoveredCapabilities[0], 'turnOn')).to.equal(false);
        expect(registry.isAllowed(id, device.discoveredCapabilities[0], 'turnOff')).to.equal(false);
        expect(registry.isAllowed(id, device.discoveredCapabilities[0], 'getState')).to.equal(false);
    });
    it('uses read and write flags independently for a generic numeric value role', () => {
        const id = 'test.0.blind';
        const stateId = `${id}.POSITION`;
        const state: ObjectSnapshot = {
            id: stateId,
            type: 'state',
            common: { role: 'value.blind', type: 'number', read: true, write: true, min: 0, max: 100, unit: '%' },
        };
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices([{ id, type: 'channel', common: { name: 'Rollladen' } }, state]));
        const capability = registry.list()[0].discoveredCapabilities[0];
        expect(capability.kind).to.equal('genericValue');
        expect(capability.role).to.equal('value.blind');
        expect(capabilityName(capability, 'de')).to.equal('POSITION');
        expect(mapCapability({ ...state, common: { ...state.common, role: 'value' } })?.kind).to.equal('genericValue');
        expect(
            capabilityName(
                mapCapability({ ...state, common: { ...state.common, name: { de: 'Stellung', en: 'Position' } } })!,
                'de',
            ),
        ).to.equal('Stellung');
        registry.setEnabled(id, true);
        registry.approve(id, stateId, 'getValue');
        registry.approve(id, stateId, 'setValue');
        expect(registry.isAllowed(id, capability, 'getValue')).to.equal(true);
        expect(registry.isAllowed(id, capability, 'setValue')).to.equal(true);
        registry.reconcile(
            discoverDevices([
                { id, type: 'channel', common: { name: 'Rollladen' } },
                { ...state, common: { ...state.common, name: 'Position' } },
            ]),
        );
        expect(registry.isAllowed(id, registry.list()[0].discoveredCapabilities[0], 'setValue')).to.equal(true);
        registry.reconcile(
            discoverDevices([
                { id, type: 'channel', common: { name: 'Rollladen' } },
                { ...state, common: { ...state.common, role: 'value.tilt' } },
            ]),
        );
        expect(registry.isAllowed(id, registry.list()[0].discoveredCapabilities[0], 'setValue')).to.equal(false);
    });
    it('maps roles offered by Admin to the intended actions', () => {
        const brightness = mapCapability({
            id: '0_userdata.0.test.HELLIGKEIT',
            type: 'state',
            common: { role: 'level.brightness', type: 'number', read: true, write: true, min: 0, max: 100 },
        });
        const actual = mapCapability({
            id: '0_userdata.0.test.IST',
            type: 'state',
            common: { role: 'value.temperature', type: 'number', read: true, write: false, unit: '°C' },
        });
        const setpoint = mapCapability({
            id: '0_userdata.0.test.SOLL',
            type: 'state',
            common: { role: 'level.temperature', type: 'number', read: true, write: true, min: 5, max: 30, unit: '°C' },
        });
        expect(brightness?.kind).to.equal('genericValue');
        expect(actual?.kind).to.equal('genericValue');
        expect(setpoint?.kind).to.equal('genericValue');
        expect(actual?.writable).to.equal(false);
        expect(setpoint?.writable).to.equal(true);
        expect(
            mapCapability({
                id: '0_userdata.0.test.SOLL',
                type: 'state',
                common: { role: 'level.temperature', type: 'number', read: true, write: false, min: 5, max: 30 },
            })?.kind,
        ).to.equal('genericValue');
    });
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
                ? { ...item, common: { ...item.common, type: 'number', role: 'level.brightness', min: 0, max: 100 } }
                : item,
        );
        registry.reconcile(discoverDevices(changed));
        expect(registry.list()[0].status).to.equal('needsReview');
        expect(registry.isAllowed(id, registry.list()[0].discoveredCapabilities[0], 'setValue')).to.equal(false);
        registry.approve(id, stateId, 'setValue');
        expect(registry.isAllowed(id, registry.list()[0].discoveredCapabilities[0], 'setValue')).to.equal(true);
    });
    it('keeps supported capabilities available beside an unmapped state', () => {
        const extra: ObjectSnapshot = {
            id: 'lamp.0.room.DEBUG',
            type: 'state',
            common: { role: 'custom', type: 'string', read: true, write: false },
        };
        const devices = discoverDevices([...base, extra]);
        expect(devices[0].discoveredCapabilities).to.have.length(1);
        expect(devices[0].status).to.equal('available');
        const registry = new DeviceRegistry();
        registry.reconcile(devices);
        registry.approve('lamp.0.room', 'lamp.0.room.POWER', 'turnOn');
        registry.reconcile(discoverDevices([...base, extra]));
        expect(registry.list()[0].status).to.equal('available');
        expect(registry.list()[0].discoveredCapabilities[0].needsReview).to.equal(false);
    });
    it('keeps a temporarily missing state approval without flagging other capabilities', () => {
        const brightness: ObjectSnapshot = {
            id: 'lamp.0.room.HELLIGKEIT',
            type: 'state',
            common: { role: 'level.brightness', type: 'number', read: true, write: true, min: 0, max: 100 },
        };
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices([...base, brightness]));
        registry.setEnabled('lamp.0.room', true);
        registry.approve('lamp.0.room', 'lamp.0.room.POWER', 'turnOn');
        registry.approve('lamp.0.room', brightness.id, 'getValue');
        registry.reconcile(discoverDevices(base));
        const device = registry.list()[0];
        expect(device.status).to.equal('available');
        expect(Object.keys(device.approvedCapabilities)).to.deep.equal([
            'turnOn:lamp.0.room.POWER',
            'getValue:lamp.0.room.HELLIGKEIT',
        ]);
        expect(registry.isAllowed(device.id, device.discoveredCapabilities[0], 'turnOn')).to.equal(true);
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
                common: { role: 'value.temperature', type: 'number', read: true, write: false },
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
        expect(temperature?.discoveredCapabilities[0].kind).to.equal('genericValue');
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
