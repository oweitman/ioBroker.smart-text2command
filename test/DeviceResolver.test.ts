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
