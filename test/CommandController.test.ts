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
        stateValue: unknown = true,
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
            getState: () => Promise.resolve({ val: stateValue }),
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
        expect(denied.response).to.equal('Ich kenne kein passendes freigegebenes Gerät.');
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        changeLive([lamp[0], { ...lamp[1], common: { ...lamp[1].common, write: false } }]);
        const changed = await controller.process(
            { requestId: 'b2', text: 'Schalte Lampe ein', mode: 'execute' },
            'admin.0',
        );
        expect(changed.errorCode).to.equal('CAPABILITY_CHANGED');
        expect(changed.response).to.equal('Der Datenpunkt hat sich geändert. Bitte prüfe die Freigabe.');
        expect(writes).to.be.empty;
    });

    it('recognizes an explicitly named unknown room before selecting a device', async () => {
        const objects: ObjectSnapshot[] = [
            ...lamp,
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['plug.0.lamp'] } },
        ];
        const { registry, controller } = fixture(objects);
        registry.setEnabled('plug.0.lamp', true);
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const german = await controller.process(
            { requestId: 'unknown-room-de', text: 'Schalte die Lampe im Kinderzimmer ein', mode: 'analyze' },
            'admin.0',
        );
        expect(german.errorCode).to.equal('UNKNOWN_ROOM');
        expect(german.response).to.equal('Ich kenne den Raum nicht.');

        const english = await controller.process(
            {
                requestId: 'unknown-room-en',
                text: 'Turn on the lamp in the nursery',
                language: 'en',
                mode: 'analyze',
            },
            'admin.0',
        );
        expect(english.errorCode).to.equal('UNKNOWN_ROOM');
        expect(english.response).to.equal("I don't know that room.");
    });

    it('recognizes the displayed room name when its technical ID differs', async () => {
        const objects: ObjectSnapshot[] = [
            ...lamp,
            {
                id: 'enum.rooms.kueche',
                type: 'enum',
                common: { name: 'Küche', members: ['plug.0.lamp'] },
            },
        ];
        const { registry, controller } = fixture(objects);
        registry.setEnabled('plug.0.lamp', true);
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const result = await controller.process(
            { requestId: 'named-room', text: 'Schalte die Lampe in der Küche ein', mode: 'analyze' },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(result.actions?.[0].deviceId).to.equal('plug.0.lamp');
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

    it('asks for a room when identical approved devices are in different rooms', async () => {
        const objects: ObjectSnapshot[] = [
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
        const { registry, controller } = fixture(objects);
        for (const id of ['test.0.living', 'test.0.bedroom']) {
            registry.setEnabled(id, true);
            registry.approve(id, `${id}.POWER`, 'turnOn');
        }
        const first = await controller.process(
            { requestId: 'room-choice-1', sessionId: 's1', text: 'Schalte die Lampe ein', mode: 'analyze' },
            'admin.0',
        );
        expect(first.clarification?.key).to.equal('room');
        expect(first.clarification?.options).to.have.length(2);
        expect(first.response.toLowerCase()).to.include('wohnzimmer');
        const second = await controller.process(
            {
                requestId: 'room-choice-2',
                sessionId: 's1',
                text: 'Wohnzimmer',
                mode: 'analyze',
                clarificationId: first.clarification!.id,
                selection: 'enum.rooms.wohnzimmer',
            },
            'admin.0',
        );
        expect(second.status).to.equal('success');
        expect(second.actions?.[0].deviceId).to.equal('test.0.living');

        const multiple = await controller.process(
            {
                requestId: 'room-choice-3',
                text: 'Schalte die Lampe im Wohnzimmer und Schlafzimmer ein',
                mode: 'analyze',
            },
            'admin.0',
        );
        expect(multiple.clarification?.key).to.equal('room');
        const chosen = await controller.process(
            {
                requestId: 'room-choice-4',
                text: 'Schlafzimmer',
                mode: 'analyze',
                clarificationId: multiple.clarification!.id,
                selection: 'enum.rooms.schlafzimmer',
            },
            'admin.0',
        );
        expect(chosen.actions?.[0].deviceId).to.equal('test.0.bedroom');
    });

    it('asks for a device when no name or alias matches but an approved option exists', async () => {
        const { registry, controller } = fixture(lamp);
        registry.setEnabled('plug.0.lamp', true);
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const result = await controller.process(
            { requestId: 'unnamed-device', text: 'Schalte den Ventilator ein', mode: 'analyze' },
            'admin.0',
        );
        expect(result.clarification?.key).to.equal('device');
        expect(result.clarification?.options?.[0].id).to.equal('plug.0.lamp');
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

    it('plans the measured temperature when asking about the heating in a room', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'test.0.heating', type: 'channel', common: { name: 'Heizung' } },
            {
                id: 'test.0.heating.SOLL',
                type: 'state',
                common: { role: 'level.temperature', type: 'number', read: true, write: true, min: 5, max: 30 },
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

        const result = await controller.process(
            {
                requestId: 'heating-temperature',
                text: 'Welche Temperatur hat die Heizung im Wohnzimmer',
                mode: 'analyze',
            },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(result.analysis?.plan).to.include({ action: 'getValue', stateId: 'test.0.heating.IST' });
        expect(result.analysis?.entities?.filter(entity => entity.type === 'room')).to.have.length(1);
        expect(writes).to.be.empty;
    });

    it('asks which approved data point to read when one device has multiple matching functions', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'test.0.heating', type: 'channel', common: { name: 'Heizung' } },
            {
                id: 'test.0.heating.SOLL',
                type: 'state',
                common: { role: 'level.temperature', type: 'number', read: true, write: true, min: 5, max: 30 },
            },
            {
                id: 'test.0.heating.IST',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false },
            },
            {
                id: 'test.0.heating.HELLIGKEIT',
                type: 'state',
                common: { role: 'level.brightness', type: 'number', read: true, write: true, min: 0, max: 100 },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['test.0.heating'] } },
        ];
        const { registry, controller } = fixture(objects, 'device.getValue');
        registry.setEnabled('test.0.heating', true);
        registry.approve('test.0.heating', 'test.0.heating.SOLL', 'getValue');
        registry.approve('test.0.heating', 'test.0.heating.IST', 'getValue');
        registry.approve('test.0.heating', 'test.0.heating.HELLIGKEIT', 'getValue');
        const first = await controller.process(
            {
                requestId: 'function-1',
                sessionId: 's1',
                text: 'Lies die Temperatur der Heizung im Wohnzimmer',
                mode: 'analyze',
            },
            'admin.0',
        );
        expect(first.clarification?.key).to.equal('capability');
        expect(first.clarification?.options).to.have.length(2);
        expect(first.response).to.include('Funktion');
        const second = await controller.process(
            {
                requestId: 'function-2',
                sessionId: 's1',
                text: 'IST',
                mode: 'analyze',
                clarificationId: first.clarification!.id,
                selection: 'test.0.heating.IST',
            },
            'admin.0',
        );
        expect(second.analysis?.plan?.stateId).to.equal('test.0.heating.IST');
        const multipleFunctions = await controller.process(
            { requestId: 'function-3', text: 'Wie warm und hell ist die Heizung im Wohnzimmer', mode: 'analyze' },
            'admin.0',
        );
        expect(multipleFunctions.clarification?.key).to.equal('capability');
    });

    it('uses speech-ready responses without claiming that a write was confirmed', async () => {
        const write = fixture(lamp);
        write.registry.setEnabled('plug.0.lamp', true);
        write.registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const accepted = await write.controller.process(
            { requestId: 'response-write', text: 'Schalte die Lampe ein', mode: 'execute' },
            'admin.0',
        );
        expect(accepted.response).to.include('wurde übergeben');
        expect(accepted.response).not.to.include('ist eingeschaltet');

        const read = fixture(lamp, 'device.getState', true);
        read.registry.setEnabled('plug.0.lamp', true);
        read.registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'getState');
        const confirmed = await read.controller.process(
            { requestId: 'response-read', text: 'Ist die Lampe an', mode: 'execute' },
            'admin.0',
        );
        expect(confirmed.response).to.equal('Das Gerät Lampe ist eingeschaltet.');

        const sensor: ObjectSnapshot[] = [
            { id: 'test.0.sensor', type: 'channel', common: { name: 'Sensor' } },
            {
                id: 'test.0.sensor.IST',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false, unit: '°C' },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { name: 'Wohnzimmer', members: ['test.0.sensor'] } },
        ];
        const valueRead = fixture(sensor, 'device.getValue', 21);
        valueRead.registry.setEnabled('test.0.sensor', true);
        valueRead.registry.approve('test.0.sensor', 'test.0.sensor.IST', 'getValue');
        const value = await valueRead.controller.process(
            { requestId: 'response-value', text: 'Wie warm ist es im Wohnzimmer', mode: 'execute' },
            'admin.0',
        );
        expect(value.response).to.equal('Der Wert von Sensor im Raum Wohnzimmer beträgt 21 °C.');
    });

    it('explains that no matching device is known in the requested room', async () => {
        const objects: ObjectSnapshot[] = [
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
        const { registry, controller } = fixture(objects, 'device.getValue');
        registry.setEnabled('test.0.living', true);
        registry.setEnabled('test.0.bedroom', true);
        registry.approve('test.0.living', 'test.0.living.HELLIGKEIT', 'getValue');
        registry.approve('test.0.bedroom', 'test.0.bedroom.POWER', 'getState');

        const result = await controller.process(
            { requestId: 'brightness-bedroom', text: 'Wie hell ist die Lampe im Schlafzimmer', mode: 'analyze' },
            'admin.0',
        );
        expect(result.status).to.equal('rejected');
        expect(result.intent).to.equal('device.getValue');
        expect(result.response).to.equal('Ich kenne das Gerät in diesem Raum nicht.');
        expect(result.analysis?.candidates).to.be.empty;
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

    it('plans a room-only temperature write for one approved setpoint', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'test.0.heating', type: 'channel', common: { name: 'Heizung' } },
            {
                id: 'test.0.heating.SOLL',
                type: 'state',
                common: { role: 'level.temperature', type: 'number', read: true, write: true, min: 5, max: 30 },
            },
            {
                id: 'test.0.heating.IST',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['test.0.heating'] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.setTemperature');
        registry.setEnabled('test.0.heating', true);
        registry.approve('test.0.heating', 'test.0.heating.SOLL', 'setTemperature');
        registry.approve('test.0.heating', 'test.0.heating.IST', 'getValue');

        const result = await controller.process(
            { requestId: 'room-temperature', text: 'Stelle im Wohnzimmer die Temperatur auf 25 Grad', mode: 'analyze' },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(result.analysis?.plan).to.include({
            action: 'setTemperature',
            stateId: 'test.0.heating.SOLL',
            value: 25,
        });
        expect(result.analysis?.policyDecision).to.equal('allowed');
        expect(writes).to.be.empty;
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
