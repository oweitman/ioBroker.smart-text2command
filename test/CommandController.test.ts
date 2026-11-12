import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandController } from '../src/commands/CommandController';
import type { DeviceIO } from '../src/commands/types';
import { discoverDevices } from '../src/devices/DeviceDiscovery';
import { DeviceRegistry } from '../src/devices/DeviceRegistry';
import type { ObjectSnapshot } from '../src/devices/types';
import { SessionStore } from '../src/dialog/SessionStore';
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
        sessions?: SessionStore,
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
            undefined,
            sessions,
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
        registry.approve('test.0.heating', 'test.0.heating.SOLL', 'setValue');
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

    it('never substitutes the bedroom lamp for an explicitly named climate device', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'test.0.lamp', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'test.0.lamp.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            { id: 'test.0.climate', type: 'channel', common: { name: 'Klima' } },
            {
                id: 'test.0.climate.boost',
                type: 'state',
                common: { role: 'button', type: 'boolean', read: false, write: true },
            },
            {
                id: 'enum.rooms.schlafzimmer',
                type: 'enum',
                common: { name: { de: 'Schlafzimmer', en: 'Bedroom' }, members: ['test.0.lamp', 'test.0.climate'] },
            },
        ];
        const { registry, controller, writes } = fixture(objects);
        registry.setEnabled('test.0.lamp', true);
        registry.approve('test.0.lamp', 'test.0.lamp.POWER', 'turnOn');
        const request = {
            requestId: 'climate-bedroom',
            text: 'schalte klima im schlafzimmer',
            mode: 'execute',
        } as const;
        const rejected = await controller.process(request, 'admin.0');
        expect(rejected.status).to.equal('rejected');
        expect(rejected.actions).to.be.undefined;
        expect(writes).to.be.empty;

        registry.setEnabled('test.0.climate', true);
        registry.setAliases('test.0.climate', { en: ['climate'] });
        registry.approve('test.0.climate', 'test.0.climate.boost', 'press');
        for (const [index, text] of [
            'Schalte Klima im Schlafzimmer',
            'Aktiviere Klima im Schlafzimmer',
            'Drücke Klima im Schlafzimmer',
        ].entries()) {
            const approved = await controller.process(
                { ...request, requestId: `climate-approved-${index}`, text },
                'admin.0',
            );
            expect(approved.status).to.equal('success');
            expect(approved.intent).to.equal('device.press');
            expect(approved.actions?.[0].deviceId).to.equal('test.0.climate');
        }
        expect(writes).to.deep.equal(Array(3).fill({ id: 'test.0.climate.boost', value: true }));
        const english = await controller.process(
            { ...request, requestId: 'climate-english', text: 'Switch climate in the bedroom', language: 'en' },
            'admin.0',
        );
        expect(english.intent).to.equal('device.press');
        expect(english.actions?.[0].deviceId).to.equal('test.0.climate');
        const off = await controller.process(
            { ...request, requestId: 'climate-off', text: 'Schalte Klima im Schlafzimmer aus' },
            'admin.0',
        );
        expect(off.status).to.equal('rejected');
        expect(writes).to.have.length(4);
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
        registry.approve('test.0.heating', 'test.0.heating.SOLL', 'setValue');
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
        registry.approve('test.0.heating', 'test.0.heating.SOLL', 'setValue');
        registry.approve('test.0.heating', 'test.0.heating.IST', 'getValue');

        const result = await controller.process(
            { requestId: 'room-temperature', text: 'Stelle im Wohnzimmer die Temperatur auf 25 Grad', mode: 'analyze' },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(result.analysis?.plan).to.include({
            action: 'setValue',
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
        registry.approve('test.0.thermostat', 'test.0.thermostat.SETPOINT', 'setValue');
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
        registry.approve('dimmer.0.lamp', 'dimmer.0.lamp.LEVEL', 'setValue');
        const first = await controller.process({ requestId: 'd1', text: 'Dimme Lampe', mode: 'execute' }, 'admin.0');
        expect(first.clarification?.key).to.equal('value');
        const second = await controller.process(
            {
                requestId: 'd2',
                text: '40 %',
                mode: 'execute',
                clarificationId: first.clarification!.id,
            },
            'admin.0',
        );
        expect(second.actions?.[0].status).to.equal('accepted');
        expect(writes[0].value).to.equal(40);
    });

    it('sets a blind position and reads the slat value through generic numeric capabilities', async () => {
        const id = 'test.0.blind';
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Rollladen' } },
            {
                id: `${id}.POSITION`,
                type: 'state',
                common: {
                    name: 'Position',
                    role: 'value',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
            {
                id: `${id}.TILT`,
                type: 'state',
                common: {
                    name: 'Lamellen',
                    role: 'value',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: [id] } },
        ];
        const write = fixture(objects, 'device.setValue', 40);
        write.registry.setEnabled(id, true);
        write.registry.approve(id, `${id}.POSITION`, 'setValue');
        write.registry.approve(id, `${id}.TILT`, 'setValue');
        const changed = await write.controller.process(
            { requestId: 'blind-write', text: 'Stelle den Rollladen im Wohnzimmer auf 25 Prozent', mode: 'execute' },
            'admin.0',
        );
        expect(changed.status).to.equal('success');
        expect(write.writes).to.deep.equal([{ id: `${id}.POSITION`, value: 25 }]);
        expect(changed.response).to.include('Position');
        const read = fixture(objects, 'device.getValue', 40);
        read.registry.setEnabled(id, true);
        read.registry.approve(id, `${id}.POSITION`, 'getValue');
        read.registry.approve(id, `${id}.TILT`, 'getValue');
        const measured = await read.controller.process(
            { requestId: 'blind-read', text: 'Wie stehen die Lamellen im Wohnzimmer', mode: 'execute' },
            'admin.0',
        );
        expect(measured.status).to.equal('success');
        expect(measured.actions?.[0].stateId).to.equal(`${id}.TILT`);
        expect(measured.response).to.include('40');
    });

    it('rejects a percentage for a temperature state even with generic write approval', async () => {
        const id = 'test.0.heating';
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Heizung' } },
            {
                id: `${id}.SOLL`,
                type: 'state',
                common: {
                    role: 'level.temperature',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 5,
                    max: 30,
                    unit: '°C',
                },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.setValue');
        registry.setEnabled(id, true);
        registry.approve(id, `${id}.SOLL`, 'setValue');
        const result = await controller.process(
            { requestId: 'wrong-unit', text: 'Stelle die Heizung auf 50 Prozent', mode: 'execute' },
            'admin.0',
        );
        expect(result.errorCode).to.equal('INVALID_VALUE');
        expect(writes).to.be.empty;
    });

    it('presses only the approved named button and asks when the target is missing', async () => {
        const id = 'test.0.blind';
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Rollladen' } },
            {
                id: `${id}.AUF`,
                type: 'state',
                common: {
                    name: { de: 'AUF', en: 'UP' },
                    role: 'button.open.blind',
                    type: 'boolean',
                    read: false,
                    write: true,
                },
            },
            {
                id: `${id}.AB`,
                type: 'state',
                common: {
                    name: { de: 'AB', en: 'DOWN' },
                    role: 'button.close.blind',
                    type: 'boolean',
                    read: false,
                    write: true,
                },
            },
            {
                id: `${id}.STOP`,
                type: 'state',
                common: { role: 'button.stop.blind', type: 'boolean', read: false, write: true },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: [id] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.turnOn');
        registry.setEnabled(id, true);
        for (const state of ['AUF', 'AB', 'STOP']) {
            registry.approve(id, `${id}.${state}`, 'press');
        }
        const planned = await controller.process(
            { requestId: 'button-analyze', text: 'Drücke AUF am Rollladen im Wohnzimmer', mode: 'analyze' },
            'admin.0',
        );
        expect(planned.intent).to.equal('device.press');
        expect(planned.analysis?.plan).to.include({ action: 'press', stateId: `${id}.AUF`, value: true });
        expect(writes).to.be.empty;
        const pressed = await controller.process(
            { requestId: 'button-press', text: 'Aktiviere AUF am Rollladen im Wohnzimmer', mode: 'execute' },
            'admin.0',
        );
        expect(pressed.actions?.[0].status).to.equal('accepted');
        expect(writes).to.deep.equal([{ id: `${id}.AUF`, value: true }]);
        const question = await controller.process(
            { requestId: 'button-question', text: 'Betätige den Taster am Rollladen im Wohnzimmer', mode: 'execute' },
            'admin.0',
        );
        expect(question.clarification?.key).to.equal('capability');
        const continued = await controller.process(
            {
                requestId: 'button-answer',
                text: 'STOP-Taste',
                selection: `${id}.STOP`,
                mode: 'execute',
                clarificationId: question.clarification!.id,
            },
            'admin.0',
        );
        expect(continued.actions?.[0].stateId).to.equal(`${id}.STOP`);
        expect(writes.at(-1)).to.deep.equal({ id: `${id}.STOP`, value: true });
        const directStop = await controller.process(
            { requestId: 'button-stop', text: 'Drücke STOP am Rollladen im Wohnzimmer', mode: 'execute' },
            'admin.0',
        );
        expect(directStop.actions?.[0].stateId).to.equal(`${id}.STOP`);
        const wrongAction = await controller.process(
            { requestId: 'button-switch', text: 'Schalte den Rollladen ein', mode: 'execute' },
            'admin.0',
        );
        expect(wrongAction.status).to.equal('rejected');
        expect(writes).to.have.length(3);
        const english = await controller.process(
            { requestId: 'button-en', text: 'Press DOWN on Rollladen', language: 'en', mode: 'execute' },
            'admin.0',
        );
        expect(english.intent).to.equal('device.press');
        expect(writes.at(-1)).to.deep.equal({ id: `${id}.AB`, value: true });
    });

    it('selects a generic state by its configured name without a device name in the request', async () => {
        const id = 'test.0.blind';
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Rollladen' } },
            {
                id: `${id}.POSITION`,
                type: 'state',
                common: {
                    name: 'Position',
                    role: 'value',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
            {
                id: `${id}.LAMELLEN`,
                type: 'state',
                common: {
                    name: 'Stellung',
                    role: 'value',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: [id] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.setValue');
        registry.setEnabled(id, true);
        registry.approve(id, `${id}.POSITION`, 'setValue');
        registry.approve(id, `${id}.LAMELLEN`, 'setValue');
        const result = await controller.process(
            { requestId: 'named-function', text: 'Setze die Stellung im Wohnzimmer auf 65 Prozent', mode: 'execute' },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(result.actions?.[0].stateId).to.equal(`${id}.LAMELLEN`);
        expect(result.response).to.include('Stellung');
        expect(writes).to.deep.equal([{ id: `${id}.LAMELLEN`, value: 65 }]);
    });

    it('continues a device question with only a room while keeping callers and sessions separate', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'test.0.heating', type: 'channel', common: { name: 'Heizung' } },
            {
                id: 'test.0.heating.IST',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false },
            },
            { id: 'test.0.sensor', type: 'channel', common: { name: 'Temperatursensor' } },
            {
                id: 'test.0.sensor.IST',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['test.0.heating'] } },
            { id: 'enum.rooms.schlafzimmer', type: 'enum', common: { members: ['test.0.sensor'] } },
        ];
        const { registry, controller } = fixture(objects, 'device.getValue', 21);
        for (const id of ['test.0.heating', 'test.0.sensor']) {
            registry.setEnabled(id, true);
            registry.approve(id, `${id}.IST`, 'getValue');
        }
        const first = await controller.process(
            { requestId: 'dialog-1', sessionId: 'speaker-a', text: 'Welche Temperatur', mode: 'execute' },
            'adapter-a:user-a',
        );
        expect(first.clarification?.key).to.equal('device');
        expect(first.response).not.to.include('Abbrechen');
        const id = first.clarification!.id;
        const secondUser = await controller.process(
            { requestId: 'dialog-other-1', sessionId: 'speaker-a', text: 'Welche Temperatur', mode: 'execute' },
            'adapter-a:user-b',
        );
        expect(secondUser.clarification?.key).to.equal('device');
        expect(secondUser.clarification?.id).not.to.equal(id);
        const otherCaller = await controller.process(
            {
                requestId: 'dialog-2',
                sessionId: 'speaker-a',
                text: 'Wohnzimmer',
                mode: 'execute',
                clarificationId: id,
            },
            'adapter-a:user-b',
        );
        expect(otherCaller.errorCode).to.equal('CLARIFICATION_EXPIRED');
        const otherSession = await controller.process(
            {
                requestId: 'dialog-3',
                sessionId: 'speaker-b',
                text: 'Wohnzimmer',
                mode: 'execute',
                clarificationId: id,
            },
            'adapter-a:user-a',
        );
        expect(otherSession.errorCode).to.equal('CLARIFICATION_EXPIRED');
        const mismatch = await controller.process(
            {
                requestId: 'dialog-4',
                sessionId: 'speaker-a',
                text: 'Keller',
                mode: 'execute',
                clarificationId: id,
            },
            'adapter-a:user-a',
        );
        expect(mismatch.status).to.equal('clarification');
        expect(mismatch.clarification?.id).to.equal(id);
        expect(mismatch.response).to.include('Heizung');
        const chosen = await controller.process(
            {
                requestId: 'dialog-5',
                sessionId: 'speaker-a',
                text: 'Wohnzimmer',
                mode: 'execute',
                clarificationId: id,
            },
            'adapter-a:user-a',
        );
        expect(chosen.status).to.equal('success');
        expect(chosen.actions?.[0].deviceId).to.equal('test.0.heating');
        const secondUserAnswer = await controller.process(
            {
                requestId: 'dialog-other-2',
                sessionId: 'speaker-a',
                text: 'Schlafzimmer',
                mode: 'execute',
                clarificationId: secondUser.clarification!.id,
            },
            'adapter-a:user-b',
        );
        expect(secondUserAnswer.actions?.[0].deviceId).to.equal('test.0.sensor');
    });

    it('keeps the original intent across a room answer and a second device question', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'test.0.sensor_a', type: 'channel', common: { name: 'Sensor A' } },
            { id: 'test.0.sensor_b', type: 'channel', common: { name: 'Sensor B' } },
            {
                id: 'test.0.sensor_a.IST',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false },
            },
            {
                id: 'test.0.sensor_b.IST',
                type: 'state',
                common: { role: 'value.temperature', type: 'number', read: true, write: false },
            },
            {
                id: 'enum.rooms.wohnzimmer',
                type: 'enum',
                common: { members: ['test.0.sensor_a', 'test.0.sensor_b'] },
            },
        ];
        const { registry, controller } = fixture(objects, 'device.getValue', 21);
        for (const id of ['test.0.sensor_a', 'test.0.sensor_b']) {
            registry.setEnabled(id, true);
            registry.approve(id, `${id}.IST`, 'getValue');
        }
        const first = await controller.process(
            { requestId: 'multi-1', sessionId: 'voice', text: 'Welche Temperatur', mode: 'execute' },
            'adapter-a:user-a',
        );
        expect(first.clarification?.key).to.equal('device');
        const second = await controller.process(
            {
                requestId: 'multi-2',
                sessionId: 'voice',
                text: 'Wohnzimmer',
                mode: 'execute',
                clarificationId: first.clarification!.id,
            },
            'adapter-a:user-a',
        );
        expect(second.clarification?.key).to.equal('device');
        expect(second.clarification?.id).not.to.equal(first.clarification!.id);
        const third = await controller.process(
            {
                requestId: 'multi-3',
                sessionId: 'voice',
                text: 'Sensor B',
                mode: 'execute',
                clarificationId: second.clarification!.id,
            },
            'adapter-a:user-a',
        );
        expect(third.status).to.equal('success');
        expect(third.intent).to.equal('device.getValue');
        expect(third.actions?.[0].deviceId).to.equal('test.0.sensor_b');
    });

    it('cancels an open question by localized text and treats a later answer as expired', async () => {
        const { registry, controller, writes } = fixture(lamp);
        registry.setEnabled('plug.0.lamp', true);
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const first = await controller.process(
            { requestId: 'cancel-1', sessionId: 'voice', text: 'Schalte den Ventilator ein', mode: 'execute' },
            'adapter-a:user-a',
        );
        expect(first.clarification?.key).to.equal('device');
        const longerPhrase = await controller.process(
            {
                requestId: 'cancel-phrase',
                sessionId: 'voice',
                text: 'Stoppe die Lampe',
                mode: 'execute',
                clarificationId: first.clarification!.id,
            },
            'adapter-a:user-a',
        );
        expect(longerPhrase.status).to.equal('clarification');
        expect(longerPhrase.clarification?.id).to.equal(first.clarification!.id);
        const stopped = await controller.process(
            {
                requestId: 'cancel-2',
                sessionId: 'voice',
                text: 'Abbrechen!',
                mode: 'execute',
                clarificationId: first.clarification!.id,
            },
            'adapter-a:user-a',
        );
        expect(stopped.status).to.equal('cancelled');
        expect(stopped.response).to.equal('Okay, die Anfrage wurde abgebrochen.');
        const after = await controller.process(
            {
                requestId: 'cancel-3',
                sessionId: 'voice',
                text: 'Lampe',
                mode: 'execute',
                clarificationId: first.clarification!.id,
            },
            'adapter-a:user-a',
        );
        expect(after.errorCode).to.equal('CLARIFICATION_EXPIRED');
        expect(writes).to.be.empty;
    });

    it('accepts an English cancellation without mentioning cancellation in the question', async () => {
        const { registry, controller, writes } = fixture(lamp);
        registry.setEnabled('plug.0.lamp', true);
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const first = await controller.process(
            { requestId: 'cancel-en-1', sessionId: 'voice', language: 'en', text: 'Turn on the fan', mode: 'execute' },
            'adapter-a:user-a',
        );
        expect(first.clarification?.key).to.equal('device');
        expect(first.response).not.to.include('Cancel');
        const cancelled = await controller.process(
            {
                requestId: 'cancel-en-2',
                sessionId: 'voice',
                language: 'en',
                text: 'Never mind.',
                mode: 'execute',
                clarificationId: first.clarification!.id,
            },
            'adapter-a:user-a',
        );
        expect(cancelled.status).to.equal('cancelled');
        expect(cancelled.response).to.equal('Okay, I cancelled the request.');
        expect(writes).to.be.empty;
    });

    it('expires a question and speaks the expiry on the next answer', async () => {
        let now = 0;
        const sessions = new SessionStore(1000, 100, () => now);
        const { registry, controller, writes } = fixture(lamp, 'device.turnOn', true, sessions);
        registry.setEnabled('plug.0.lamp', true);
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const first = await controller.process(
            { requestId: 'expiry-1', sessionId: 'voice', text: 'Schalte den Ventilator ein', mode: 'execute' },
            'adapter-a:user-a',
        );
        expect(first.clarification?.key).to.equal('device');
        now = 1000;
        const expired = await controller.process(
            {
                requestId: 'expiry-2',
                sessionId: 'voice',
                text: 'Lampe',
                mode: 'execute',
                clarificationId: first.clarification!.id,
            },
            'adapter-a:user-a',
        );
        expect(expired.errorCode).to.equal('CLARIFICATION_EXPIRED');
        expect(expired.response).to.include('abgelaufen');
        expect(writes).to.be.empty;
    });

    it('starts a new request without a clarification ID and clears the old question', async () => {
        const { registry, controller } = fixture(lamp);
        registry.setEnabled('plug.0.lamp', true);
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const first = await controller.process(
            { requestId: 'replace-1', sessionId: 'voice', text: 'Schalte den Ventilator ein', mode: 'analyze' },
            'adapter-a:user-a',
        );
        expect(first.clarification?.key).to.equal('device');
        const newRequest = await controller.process(
            { requestId: 'replace-2', sessionId: 'voice', text: 'Schalte die Lampe ein', mode: 'analyze' },
            'adapter-a:user-a',
        );
        expect(newRequest.status).to.equal('success');
        const oldAnswer = await controller.process(
            {
                requestId: 'replace-3',
                sessionId: 'voice',
                text: 'Lampe',
                mode: 'analyze',
                clarificationId: first.clarification!.id,
            },
            'adapter-a:user-a',
        );
        expect(oldAnswer.errorCode).to.equal('CLARIFICATION_EXPIRED');
    });
});
