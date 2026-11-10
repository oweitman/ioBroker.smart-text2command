import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandController } from '../src/commands/CommandController';
import type { DeviceIO } from '../src/commands/types';
import { discoverDevices } from '../src/devices/DeviceDiscovery';
import { DeviceRegistry } from '../src/devices/DeviceRegistry';
import type { ObjectSnapshot } from '../src/devices/types';
import type { NlpEngine } from '../src/nlp/NlpEngine';
import { AuditRepository } from '../src/storage/AuditRepository';

describe('command pipeline', () => {
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'smart-text2command-command-'));
    });
    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    function fixture(
        states: ObjectSnapshot[],
        intent = 'device.turnOn',
    ): {
        registry: DeviceRegistry;
        controller: CommandController;
        writes: Array<{ id: string; value: boolean | number | string }>;
        changeLive: (objects: ObjectSnapshot[]) => void;
    } {
        const registry = new DeviceRegistry();
        registry.reconcile(discoverDevices(states));
        const writes: Array<{ id: string; value: boolean | number | string }> = [];
        let live = states;
        const io: DeviceIO = {
            getObject: id => Promise.resolve(live.find(item => item.id === id)),
            getState: () => Promise.resolve({ val: true }),
            setState: (id, value) => {
                writes.push({ id, value });
                return Promise.resolve();
            },
        };
        const model: NlpEngine = {
            load: () => Promise.resolve(),
            train: () => Promise.resolve(''),
            analyze: () =>
                Promise.resolve({
                    intent,
                    confidence: 0.95,
                    entities: [],
                    alternatives: [{ intent, confidence: 0.95 }],
                }),
        };
        const controller = new CommandController(
            registry,
            io,
            () => ({ engine: model, version: 'test' }),
            () => [],
            new AuditRepository(join(directory, 'audit.json')),
        );
        return {
            registry,
            controller,
            writes,
            changeLive: (objects: ObjectSnapshot[]) => {
                live = objects;
            },
        };
    }

    const lamp: ObjectSnapshot[] = [
        { id: 'plug.0.lamp', type: 'device', common: { name: 'Lampe' } },
        {
            id: 'plug.0.lamp.POWER',
            type: 'state',
            common: { role: 'switch', type: 'boolean', read: true, write: true },
        },
    ];

    it('analyzes without device writes and executes one approved command with idempotency', async () => {
        const { registry, controller, writes } = fixture(lamp);
        registry.setEnabled('plug.0.lamp', true);
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const analysis = await controller.process(
            { requestId: 'a1', text: 'Schalte Lampe ein', mode: 'analyze' },
            'admin.0',
        );
        expect(analysis.actions?.[0].status).to.equal('planned');
        expect(analysis.analysis?.policyDecision).to.equal('allowed');
        expect(analysis.analysis?.plan?.stateId).to.equal('plug.0.lamp.POWER');
        expect(writes).to.be.empty;
        const request = { requestId: 'a2', text: 'Schalte Lampe ein', mode: 'execute' } as const;
        const executed = await controller.process(request, 'admin.0');
        expect(executed.actions?.[0].status).to.equal('accepted');
        await controller.process(request, 'admin.0');
        expect(writes).to.deep.equal([{ id: 'plug.0.lamp.POWER', value: true }]);
    });

    it('rejects a changed target and an unapproved action before writing', async () => {
        const { registry, controller, writes, changeLive } = fixture(lamp);
        registry.setEnabled('plug.0.lamp', true);
        const denied = await controller.process(
            { requestId: 'b1', text: 'Schalte Lampe ein', mode: 'execute' },
            'admin.0',
        );
        expect(denied.status).to.equal('rejected');
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        changeLive([lamp[0], { ...lamp[1], common: { ...lamp[1].common, write: false } }]);
        const changed = await controller.process(
            { requestId: 'b2', text: 'Schalte Lampe ein', mode: 'execute' },
            'admin.0',
        );
        expect(changed.errorCode).to.equal('CAPABILITY_CHANGED');
        expect(writes).to.be.empty;
    });

    it('binds ambiguous device clarification to client and session', async () => {
        const second: ObjectSnapshot[] = [
            { id: 'plug.0.other', type: 'device', common: { name: 'Lampe' } },
            {
                id: 'plug.0.other.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
        ];
        const { registry, controller, writes } = fixture([...lamp, ...second]);
        for (const id of ['plug.0.lamp', 'plug.0.other']) {
            registry.setEnabled(id, true);
            registry.approve(id, `${id}.POWER`, 'turnOn');
        }
        const first = await controller.process(
            { requestId: 'c1', sessionId: 's1', text: 'Schalte Lampe ein', mode: 'execute' },
            'admin.0',
        );
        expect(first.status).to.equal('clarification');
        const id = first.clarification!.id;
        const wrong = await controller.process(
            {
                requestId: 'c2',
                sessionId: 's1',
                text: 'Lampe',
                mode: 'execute',
                clarificationId: id,
                selection: 'plug.0.lamp',
            },
            'other.0',
        );
        expect(wrong.status).to.equal('rejected');
        const chosen = await controller.process(
            {
                requestId: 'c3',
                sessionId: 's1',
                text: 'Lampe',
                mode: 'execute',
                clarificationId: id,
                selection: 'plug.0.lamp',
            },
            'admin.0',
        );
        expect(chosen.actions?.[0].status).to.equal('accepted');
        expect(writes).to.have.length(1);
    });

    it('extracts the room and resolves an approved lamp in that room', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'plug.0.wohnzimmer', type: 'channel', common: { name: 'Lampe' } },
            { id: 'plug.0.schlafzimmer', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'plug.0.wohnzimmer.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            {
                id: 'plug.0.schlafzimmer.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['plug.0.wohnzimmer'] } },
            { id: 'enum.rooms.schlafzimmer', type: 'enum', common: { members: ['plug.0.schlafzimmer'] } },
        ];
        const { registry, controller, writes } = fixture(objects);
        for (const id of ['plug.0.wohnzimmer', 'plug.0.schlafzimmer']) {
            registry.setEnabled(id, true);
            registry.approve(id, `${id}.POWER`, 'turnOn');
        }
        const result = await controller.process(
            { requestId: 'room-1', text: 'Schalte die Lampe im Wohnzimmer ein', mode: 'analyze' },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(result.actions?.[0].deviceId).to.equal('plug.0.wohnzimmer');
        expect(result.analysis?.entities).to.satisfy((entities: Array<{ type: string; value: unknown }>) =>
            entities.some(entity => entity.type === 'room' && entity.value === 'wohnzimmer'),
        );
        expect(writes).to.be.empty;
    });

    it('plans a temperature read when only the room identifies the sensor', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'test.0.lamp', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'test.0.lamp.HELLIGKEIT',
                type: 'state',
                common: { role: 'level.brightness', type: 'number', read: true, write: true, min: 0, max: 100 },
            },
            { id: 'test.0.sensor', type: 'channel', common: { name: 'Temperatursensor' } },
            {
                id: 'test.0.sensor.IST',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false, unit: '°C' },
            },
            {
                id: 'test.0.sensor.HELLIGKEIT',
                type: 'state',
                common: { role: 'level.brightness', type: 'number', read: true, write: true, min: 0, max: 100 },
            },
            { id: 'enum.rooms.schlafzimmer', type: 'enum', common: { members: ['test.0.lamp', 'test.0.sensor'] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.getValue');
        registry.setEnabled('test.0.lamp', true);
        registry.approve('test.0.lamp', 'test.0.lamp.HELLIGKEIT', 'getValue');
        registry.setEnabled('test.0.sensor', true);
        registry.approve('test.0.sensor', 'test.0.sensor.IST', 'getValue');
        registry.approve('test.0.sensor', 'test.0.sensor.HELLIGKEIT', 'getValue');
        const result = await controller.process(
            { requestId: 'room-read', text: 'Wie warm ist es im Schlafzimmer', mode: 'analyze' },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(result.analysis?.candidates?.[0].deviceId).to.equal('test.0.sensor');
        expect(result.analysis?.plan?.stateId).to.equal('test.0.sensor.IST');
        expect(writes).to.be.empty;
    });

    it('asks for the missing value when a room-only command explicitly writes the setpoint', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'test.0.heating', type: 'channel', common: { name: 'Heizung' } },
            {
                id: 'test.0.heating.SOLL',
                type: 'state',
                common: { role: 'level.temperature', type: 'number', read: true, write: true, min: 16, max: 28 },
            },
            {
                id: 'test.0.heating.IST',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['test.0.heating'] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.getValue');
        registry.setEnabled('test.0.heating', true);
        registry.approve('test.0.heating', 'test.0.heating.SOLL', 'setTemperature');
        registry.approve('test.0.heating', 'test.0.heating.IST', 'getValue');

        const first = await controller.process(
            { requestId: 'setpoint-1', text: 'schreibe im wohnzimmer die soll temperatur', mode: 'execute' },
            'admin.0',
        );
        expect(first.intent).to.equal('device.setTemperature');
        expect(first.status).to.equal('clarification');
        expect(first.clarification?.key).to.equal('value');
        expect(writes).to.be.empty;

        const second = await controller.process(
            {
                requestId: 'setpoint-2',
                text: '21 Grad',
                mode: 'execute',
                clarificationId: first.clarification!.id,
                selection: '21 Grad',
            },
            'admin.0',
        );
        expect(second.actions?.[0].stateId).to.equal('test.0.heating.SOLL');
        expect(writes).to.deep.equal([{ id: 'test.0.heating.SOLL', value: 21 }]);
    });

    it('handles an English room-only setpoint command without reading the current temperature', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'test.0.thermostat', type: 'channel', common: { name: 'Thermostat' } },
            {
                id: 'test.0.thermostat.SETPOINT',
                type: 'state',
                common: { role: 'level.temperature', type: 'number', read: true, write: true, min: 16, max: 28 },
            },
            {
                id: 'test.0.thermostat.CURRENT',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false },
            },
            { id: 'enum.rooms.living_room', type: 'enum', common: { members: ['test.0.thermostat'] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.getValue');
        registry.setEnabled('test.0.thermostat', true);
        registry.approve('test.0.thermostat', 'test.0.thermostat.SETPOINT', 'setTemperature');
        registry.approve('test.0.thermostat', 'test.0.thermostat.CURRENT', 'getValue');

        const result = await controller.process(
            {
                requestId: 'setpoint-en',
                text: 'Write the target temperature in the living room',
                mode: 'execute',
                language: 'en',
            },
            'admin.0',
        );
        expect(result.intent).to.equal('device.setTemperature');
        expect(result.status).to.equal('clarification');
        expect(result.clarification?.key).to.equal('value');
        expect(writes).to.be.empty;
    });

    it('asks for a missing level and validates the selected value', async () => {
        const dimmer: ObjectSnapshot[] = [
            { id: 'dimmer.0.lamp', type: 'device', common: { name: 'Lampe' } },
            {
                id: 'dimmer.0.lamp.LEVEL',
                type: 'state',
                common: { role: 'level.brightness', type: 'number', read: true, write: true, min: 0, max: 100 },
            },
        ];
        const { registry, controller, writes } = fixture(dimmer, 'device.setLevel');
        registry.setEnabled('dimmer.0.lamp', true);
        registry.approve('dimmer.0.lamp', 'dimmer.0.lamp.LEVEL', 'setLevel');
        const first = await controller.process({ requestId: 'd1', text: 'Dimme Lampe', mode: 'execute' }, 'admin.0');
        expect(first.clarification?.key).to.equal('value');
        const second = await controller.process(
            {
                requestId: 'd2',
                text: '40 %',
                mode: 'execute',
                clarificationId: first.clarification!.id,
                selection: '40 %',
            },
            'admin.0',
        );
        expect(second.actions?.[0].status).to.equal('accepted');
        expect(writes[0].value).to.equal(40);
    });
});
