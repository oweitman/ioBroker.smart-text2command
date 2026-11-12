import { expect } from 'chai';
import { discoverDevices } from '../src/devices/DeviceDiscovery';
import { DeviceRegistry } from '../src/devices/DeviceRegistry';
import { DeviceResolver } from '../src/devices/DeviceResolver';
import type { ObjectSnapshot } from '../src/devices/types';

const objects: ObjectSnapshot[] = [
    { id: 'plug.0.a', type: 'device', common: { name: 'Lampe' } },
    { id: 'plug.0.a.POWER', type: 'state', common: { role: 'switch', type: 'boolean', read: true, write: true } },
    { id: 'plug.0.b', type: 'device', common: { name: 'Lampe' } },
    { id: 'plug.0.b.POWER', type: 'state', common: { role: 'switch', type: 'boolean', read: true, write: true } },
    { id: 'enum.rooms.kitchen', type: 'enum', common: { members: ['plug.0.a'] } },
];

describe('device resolver', () => {
    it('uses configured device aliases with a room for a polite switch-off request', () => {
        const source: ObjectSnapshot[] = [
            { id: 'test.0.living', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'test.0.living.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            { id: 'test.0.bedroom', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'test.0.bedroom.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['test.0.living'] } },
            { id: 'enum.rooms.schlafzimmer', type: 'enum', common: { members: ['test.0.bedroom'] } },
        ];
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices(source));
        for (const id of ['test.0.living', 'test.0.bedroom']) {
            registry.setEnabled(id, true);
            registry.setAliases(id, { de: ['Leuchte'] });
            registry.approve(id, `${id}.POWER`, 'turnOff');
        }
        const resolver = new DeviceResolver(registry);
        expect(
            resolver.resolve('könntest du freundlicherweise die leuchte im Wohnzimmer deaktivieren', 'de', 'turnOff')
                .selected?.deviceId,
        ).to.equal('test.0.living');
        expect(resolver.resolve('deaktiviere die Leuchte', 'de', 'turnOff').clarification).to.equal(true);
    });
    it('uses a room-only phrase for a unique approved read target and asks when several qualify', () => {
        const source: ObjectSnapshot[] = [
            { id: 'test.0.lamp', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'test.0.lamp.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            {
                id: 'test.0.lamp.HELLIGKEIT',
                type: 'state',
                common: { role: 'level.brightness', type: 'number', read: true, write: true, min: 0, max: 100 },
            },
            { id: 'test.0.sensor', type: 'channel', common: { name: 'Temperatursensor' } },
            {
                id: 'test.0.sensor.IST',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false },
            },
            {
                id: 'enum.rooms.schlafzimmer',
                type: 'enum',
                common: { members: ['test.0.lamp', 'test.0.sensor'] },
            },
        ];
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices(source));
        registry.setEnabled('test.0.lamp', true);
        registry.approve('test.0.lamp', 'test.0.lamp.POWER', 'turnOn');
        registry.approve('test.0.lamp', 'test.0.lamp.HELLIGKEIT', 'getValue');
        registry.setEnabled('test.0.sensor', true);
        registry.approve('test.0.sensor', 'test.0.sensor.IST', 'getValue');
        const resolver = new DeviceResolver(registry);
        expect(resolver.resolve('Wie warm ist es im Schlafzimmer', 'de', 'getValue').selected?.deviceId).to.equal(
            'test.0.sensor',
        );
        expect(resolver.resolve('Wie hell ist es im Schlafzimmer', 'de', 'getValue').selected?.deviceId).to.equal(
            'test.0.lamp',
        );
        expect(resolver.resolve('Schalte im Schlafzimmer ein', 'de', 'turnOn').selected?.deviceId).to.equal(
            'test.0.lamp',
        );

        const secondSensor: ObjectSnapshot[] = [
            { id: 'test.0.sensor2', type: 'channel', common: { name: 'Zweiter Sensor' } },
            {
                id: 'test.0.sensor2.IST',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false },
            },
        ];
        const secondRoom = {
            ...source.find(item => item.id === 'enum.rooms.schlafzimmer')!,
            common: { members: ['test.0.lamp', 'test.0.sensor', 'test.0.sensor2'] },
        };
        registry.reconcile(
            discoverDevices([...source.filter(item => item.type !== 'enum'), secondRoom, ...secondSensor]),
        );
        registry.setEnabled('test.0.sensor2', true);
        registry.approve('test.0.sensor2', 'test.0.sensor2.IST', 'getValue');
        expect(resolver.resolve('Wie warm ist es im Schlafzimmer', 'de', 'getValue').clarification).to.equal(true);
    });
    it('does not operate the only approved room device when another device is named', () => {
        const source: ObjectSnapshot[] = [
            { id: 'test.0.lamp', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'test.0.lamp.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            { id: 'test.0.climate', type: 'channel', common: { name: 'Klima' } },
            {
                id: 'test.0.climate.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            {
                id: 'enum.rooms.schlafzimmer',
                type: 'enum',
                common: { members: ['test.0.lamp', 'test.0.climate'] },
            },
        ];
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices(source));
        registry.setEnabled('test.0.lamp', true);
        registry.approve('test.0.lamp', 'test.0.lamp.POWER', 'turnOn');
        const resolver = new DeviceResolver(registry);
        expect(resolver.resolve('Schalte im Schlafzimmer ein', 'de', 'turnOn').selected?.deviceId).to.equal(
            'test.0.lamp',
        );
        expect(resolver.resolve('Schalte Klima im Schlafzimmer', 'de', 'turnOn').candidates).to.be.empty;
        expect(resolver.resolve('Schalte Klimaanlage im Schlafzimmer', 'de', 'turnOn').candidates).to.be.empty;
        registry.setEnabled('test.0.climate', true);
        registry.approve('test.0.climate', 'test.0.climate.POWER', 'turnOn');
        expect(resolver.resolve('Schalte Klima im Schlafzimmer', 'de', 'turnOn').selected?.deviceId).to.equal(
            'test.0.climate',
        );
        expect(resolver.resolve('Switch the climate in the bedroom', 'en', 'turnOn').candidates).to.be.empty;
    });
    it('does not read brightness from another room when the named lamp has no brightness state', () => {
        const source: ObjectSnapshot[] = [
            { id: 'test.0.living', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'test.0.living.HELLIGKEIT',
                type: 'state',
                common: { role: 'level.brightness', type: 'number', read: true, write: true, min: 0, max: 100 },
            },
            { id: 'test.0.bedroom', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'test.0.bedroom.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['test.0.living'] } },
            { id: 'enum.rooms.schlafzimmer', type: 'enum', common: { members: ['test.0.bedroom'] } },
        ];
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices(source));
        for (const id of ['test.0.living', 'test.0.bedroom']) {
            registry.setEnabled(id, true);
        }
        registry.approve('test.0.living', 'test.0.living.HELLIGKEIT', 'getValue');
        registry.approve('test.0.bedroom', 'test.0.bedroom.POWER', 'getState');
        const resolver = new DeviceResolver(registry);
        expect(resolver.resolve('Wie hell ist die Lampe im Schlafzimmer', 'de', 'getValue').candidates).to.be.empty;
    });
    it('asks which thermostat to use when a room has two approved temperature targets', () => {
        const source: ObjectSnapshot[] = [
            ...['first', 'second'].flatMap(name => [
                { id: `test.0.${name}`, type: 'channel' as const, common: { name: 'Heizung' } },
                {
                    id: `test.0.${name}.SOLL`,
                    type: 'state' as const,
                    common: {
                        role: 'level.temperature',
                        type: 'number' as const,
                        read: true,
                        write: true,
                        min: 5,
                        max: 30,
                    },
                },
            ]),
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['test.0.first', 'test.0.second'] } },
        ];
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices(source));
        for (const id of ['test.0.first', 'test.0.second']) {
            registry.setEnabled(id, true);
            registry.approve(id, `${id}.SOLL`, 'setValue');
        }
        const result = new DeviceResolver(registry).resolve(
            'Stelle im Wohnzimmer die Temperatur auf 25 Grad',
            'de',
            'setValue',
        );
        expect(result.candidates).to.have.length(2);
        expect(result.clarification).to.equal(true);
    });
    it('asks when names tie and uses room or updated alias without retraining', () => {
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices(objects));
        for (const id of ['plug.0.a', 'plug.0.b']) {
            registry.setEnabled(id, true);
            registry.approve(id, `${id}.POWER`, 'turnOn');
        }
        const resolver = new DeviceResolver(registry);
        expect(resolver.resolve('Schalte die Lampe ein', 'de', 'turnOn').clarification).to.equal(true);
        expect(resolver.resolve('Schalte die Lampe in der kitchen ein', 'de', 'turnOn').selected?.deviceId).to.equal(
            'plug.0.a',
        );
        registry.setAliases('plug.0.b', { de: ['Stehlampe'] });
        expect(resolver.resolve('Schalte die Stehlampe ein', 'de', 'turnOn').selected?.deviceId).to.equal('plug.0.b');
        expect(resolver.resolve('Schalte die Stehlampe aus', 'de', 'turnOff').candidates).to.be.empty;
        expect(resolver.resolve('Schalte die Stehlamne ein', 'de', 'turnOn').selected?.deviceId).to.equal('plug.0.b');
        expect(resolver.resolve('Schalte die Stehlamxx ein', 'de', 'turnOn').clarification).to.equal(true);
    });
});
