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
import type { IntentDefinition } from '../src/nlp/types';
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
        nlpConfidence = 0.95,
        userIntents: IntentDefinition[] = [],
        stateQuality?: number,
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
            getState: () =>
                Promise.resolve({ val: stateValue, ...(stateQuality !== undefined ? { q: stateQuality } : {}) }),
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
                    confidence: nlpConfidence,
                    entities: [],
                    alternatives:
                        nlpConfidence < 0.65
                            ? [
                                  { intent, confidence: nlpConfidence },
                                  { intent: 'device.setTemperature', confidence: 1 - nlpConfidence },
                              ]
                            : [{ intent, confidence: nlpConfidence }],
                }),
        };
        const controller = new CommandController(
            registry,
            io,
            () => ({ engine: model, version: 'test' }),
            () => userIntents,
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

    it('uses the percentage after a numbered lamp name as the brightness value', async () => {
        const id = '0_userdata.0.test_lampe5_rgb_lampenzimmer';
        const level = `${id}.brightness`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Lampe5' } },
            {
                id: level,
                type: 'state',
                common: {
                    name: 'Helligkeit',
                    role: 'level.brightness',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
            { id: 'enum.rooms.lampenzimmer', type: 'enum', common: { name: 'Lampenzimmer', members: [id] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.setValue');
        registry.setEnabled(id, true);
        registry.approve(id, level, 'setValue');
        const text = 'Stelle die Helligkeit von Lampe 5 im Lampenzimmer auf 50%';
        const result = await controller.process({ requestId: 'numbered-lamp', text, mode: 'execute' }, 'admin.0');
        expect(result.status, JSON.stringify(result)).to.equal('success');
        expect(writes).to.deep.equal([{ id: level, value: 50 }]);
        const ambiguous = await controller.process(
            { requestId: 'numbered-lamp-ambiguous', text: `${text} oder 60%`, mode: 'execute' },
            'admin.0',
        );
        expect(ambiguous.errorCode).to.equal('INVALID_VALUE');
        expect(writes).to.have.length(1);
    });

    it('plans and executes an approved relative brightness change', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'plug.0.dimmer', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'plug.0.dimmer.LEVEL',
                type: 'state',
                common: {
                    name: 'Helligkeit',
                    role: 'level.brightness',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.turnOff', 50, undefined, 0.3);
        registry.setEnabled('plug.0.dimmer', true);
        registry.approve('plug.0.dimmer', 'plug.0.dimmer.LEVEL', 'setValue');
        const analyzed = await controller.process(
            { requestId: 'relative-1', text: 'Mach die Lampe etwas heller', mode: 'analyze' },
            'admin.0',
        );
        expect(analyzed.status).to.equal('success');
        expect(analyzed.actions?.[0].value).to.equal(55);
        expect(writes).to.be.empty;
        const executed = await controller.process(
            { requestId: 'relative-2', text: 'Mach die Lampe etwas heller', mode: 'execute' },
            'admin.0',
        );
        expect(executed.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: 'plug.0.dimmer.LEVEL', value: 55 }]);
    });

    it('uses a unique generic percentage state on an arbitrarily named device and asks when two qualify', async () => {
        const id = 'test.0.orion';
        const alpha = `${id}.alpha`;
        const beta = `${id}.beta`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Orion' } },
            {
                id: alpha,
                type: 'state',
                common: {
                    name: 'Alpha',
                    role: 'level',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
            {
                id: beta,
                type: 'state',
                common: {
                    name: 'Beta',
                    role: 'level',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.turnOff', 50);
        registry.setEnabled(id, true);
        registry.approve(id, alpha, 'setValue');
        const unique = await controller.process(
            { requestId: 'unique-generic', text: 'Mach Orion etwas heller', mode: 'analyze' },
            'admin.0',
        );
        expect(unique.status).to.equal('success');
        expect(unique.actions?.[0].stateId).to.equal(alpha);
        registry.approve(id, beta, 'setValue');
        const question = await controller.process(
            { requestId: 'ambiguous-generic', text: 'Mach Orion etwas heller', mode: 'execute' },
            'admin.0',
        );
        expect(question.clarification?.key).to.equal('relativeCapability');
        expect(question.clarification?.options?.map(item => item.label)).to.deep.equal(['Alpha', 'Beta']);
        expect(writes).to.be.empty;
        const answer = await controller.process(
            {
                requestId: 'selected-generic',
                text: 'Beta',
                mode: 'execute',
                clarificationId: question.clarification!.id,
            },
            'admin.0',
        );
        expect(answer.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: beta, value: 55 }]);
    });

    it('sets a unique fan percentage state to maximum without using an unconfirmed current value', async () => {
        const id = 'test.0.venti';
        const speed = `${id}.speed`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'venti' } },
            {
                id: `${id}.power`,
                type: 'state',
                common: { name: 'power', role: 'switch', type: 'boolean', read: true, write: true },
            },
            {
                id: speed,
                type: 'state',
                common: {
                    name: 'speed',
                    role: 'level',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
            { id: 'enum.rooms.ventizimmer', type: 'enum', common: { name: 'Ventizimmer', members: [id] } },
            { id: 'enum.functions.ventilator', type: 'enum', common: { name: 'Ventilator', members: [id] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.press', 0, undefined, 0.95, [], 32);
        registry.setEnabled(id, true);
        registry.approve(id, speed, 'setValue');
        const planned = await controller.process(
            { requestId: 'venti-maximum-analyze', text: 'mach den venti im ventizimmer auf maximum', mode: 'analyze' },
            'admin.0',
        );
        expect(planned.status).to.equal('success');
        expect(planned.actions?.[0].value).to.equal(100);
        expect(writes).to.be.empty;
        const result = await controller.process(
            { requestId: 'venti-maximum', text: 'mach den venti im ventizimmer auf maximum', mode: 'execute' },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: speed, value: 100 }]);
        const relative = await controller.process(
            { requestId: 'venti-schneller-quality', text: 'mach den venti im ventizimmer schneller', mode: 'execute' },
            'admin.0',
            true,
        );
        expect(relative.errorCode).to.equal('INVALID_CURRENT_VALUE');
        expect(relative.analysis?.currentState?.quality).to.equal(32);
        expect(writes).to.have.length(1);
    });

    it('asks which percentage state to set when a named device has two maximum candidates', async () => {
        const id = 'test.0.venti';
        const speed = `${id}.speed`;
        const light = `${id}.light`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'venti' } },
            {
                id: speed,
                type: 'state',
                common: {
                    name: 'Geschwindigkeit',
                    role: 'level',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
            {
                id: light,
                type: 'state',
                common: {
                    name: 'Helligkeit',
                    role: 'level.brightness',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.press', 0);
        registry.setEnabled(id, true);
        registry.approve(id, speed, 'setValue');
        registry.approve(id, light, 'setValue');
        const question = await controller.process(
            { requestId: 'venti-maximum-ambiguous', text: 'mach venti auf maximum', mode: 'execute' },
            'admin.0',
        );
        expect(question.clarification?.key).to.equal('relativeCapability');
        expect(writes).to.be.empty;
        const answer = await controller.process(
            {
                requestId: 'venti-maximum-selected',
                text: 'Geschwindigkeit',
                mode: 'execute',
                clarificationId: question.clarification!.id,
            },
            'admin.0',
        );
        expect(answer.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: speed, value: 100 }]);
    });

    it('selects the named generic dimmer state over RGB and handles a current value of zero', async () => {
        const id = '0_userdata.0.test_lampe5_rgb_lampenzimmer';
        const dimmer = `${id}.dimmer`;
        const color = `${id}.color`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'lampe5 ' } },
            {
                id: dimmer,
                type: 'state',
                common: {
                    name: 'dimmer',
                    role: 'level',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
            {
                id: color,
                type: 'state',
                common: { name: 'color', role: 'level.color.rgb', type: 'string', read: true, write: true },
            },
            {
                id: `${id}.temperature`,
                type: 'state',
                common: {
                    name: 'temperature',
                    role: 'level.color.temperature',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 2200,
                    max: 6500,
                    unit: 'K',
                },
            },
            { id: 'enum.rooms.lampenzimmer', type: 'enum', common: { name: 'Lampenzimmer', members: [id] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.turnOff', 0);
        registry.setEnabled(id, true);
        registry.approve(id, dimmer, 'setValue');
        registry.approve(id, color, 'setValue');
        const result = await controller.process(
            { requestId: 'lamp5-dimmer-zero', text: 'mach den dimmer der lampe5 viel heller', mode: 'execute' },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: dimmer, value: 20 }]);
        registry.revoke(id, dimmer, 'setValue');
        const unapproved = await controller.process(
            { requestId: 'lamp5-dimmer-unapproved', text: 'mach den dimmer der lampe5 viel heller', mode: 'execute' },
            'admin.0',
        );
        expect(unapproved.errorCode).to.equal('ACTION_NOT_APPROVED');
        expect(writes).to.have.length(1);
    });

    it('reports the selected state and value type when a relative current value is invalid', async () => {
        const id = 'test.0.lampe5';
        const stateId = `${id}.dimmer`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Lampe5' } },
            {
                id: stateId,
                type: 'state',
                common: {
                    name: 'Regler',
                    role: 'level',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 0,
                    max: 100,
                    unit: '%',
                },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.turnOff', '0');
        registry.setEnabled(id, true);
        registry.approve(id, stateId, 'setValue');
        const result = await controller.process(
            { requestId: 'invalid-dimmer-state', text: 'mach lampe5 viel heller', mode: 'analyze' },
            'admin.0',
        );
        expect(result.errorCode).to.equal('INVALID_CURRENT_VALUE');
        expect(result.analysis?.currentState).to.deep.equal({
            stateId,
            valueType: 'string',
            value: '0',
            issue: 'type',
        });
        expect(writes).to.be.empty;
    });

    it('does not guess between room temperature and light color temperature', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'plug.0.heater', type: 'channel', common: { name: 'Heizung' } },
            {
                id: 'plug.0.heater.SET',
                type: 'state',
                common: {
                    role: 'value.temperature',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 17,
                    max: 26,
                    unit: '°C',
                },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['plug.0.heater'] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.turnOn', 21);
        registry.setEnabled('plug.0.heater', true);
        registry.approve('plug.0.heater', 'plug.0.heater.SET', 'setValue');
        const result = await controller.process(
            { requestId: 'warm-room-only', text: 'Mach es im Wohnzimmer wärmer', mode: 'execute' },
            'admin.0',
        );
        expect(result.status).to.equal('rejected');
        expect(writes).to.be.empty;
    });

    it('plans a named RGB color without switching the lamp on', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'plug.0.rgb', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'plug.0.rgb.COLOR',
                type: 'state',
                common: {
                    name: 'Farbe',
                    role: 'level.color.rgb',
                    type: 'string',
                    read: true,
                    write: true,
                },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['plug.0.rgb'] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.turnOff', '#ffffff', undefined, 0.3);
        registry.setEnabled('plug.0.rgb', true);
        registry.approve('plug.0.rgb', 'plug.0.rgb.COLOR', 'setValue');
        const result = await controller.process(
            { requestId: 'named-color', text: 'Stelle die Lampe auf Türkis', mode: 'analyze' },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(result.actions?.[0].value).to.equal('#00ffff');
        expect(writes).to.be.empty;
        const unnamed = await controller.process(
            { requestId: 'unnamed-color', text: 'Stelle im Wohnzimmer auf Türkis', mode: 'execute' },
            'admin.0',
        );
        expect(unnamed.status).to.equal('rejected');
        expect(writes).to.be.empty;
    });

    it('uses a supplied catalog color on the first request for an exact device name', async () => {
        const id = 'test.0.lampe5';
        const stateId = `${id}.color`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'lampe5 ' } },
            {
                id: stateId,
                type: 'state',
                common: { name: 'Farbe', role: 'level.color.rgb', type: 'string', read: true, write: true },
            },
            {
                id: `${id}.temperature`,
                type: 'state',
                common: {
                    name: 'temperature',
                    role: 'level.color.temperature',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 2200,
                    max: 6500,
                    unit: 'K',
                },
            },
            { id: 'test.0.lampe', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'test.0.lampe.color',
                type: 'state',
                common: { name: 'Farbe', role: 'level.color.rgb', type: 'string', read: true, write: true },
            },
            { id: 'test.0.lampe6', type: 'channel', common: { name: 'lampe6' } },
            {
                id: 'test.0.lampe6.color',
                type: 'state',
                common: { name: 'Farbe', role: 'level.color.rgbw', type: 'string', read: true, write: true },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.setTemperature', '#000000', undefined, 0.71);
        registry.setEnabled(id, true);
        registry.approve(id, stateId, 'setValue');
        registry.setEnabled('test.0.lampe', true);
        registry.approve('test.0.lampe', 'test.0.lampe.color', 'setValue');
        registry.setEnabled('test.0.lampe6', true);
        registry.approve('test.0.lampe6', 'test.0.lampe6.color', 'setValue');
        const result = await controller.process(
            { requestId: 'strohgelb-first', text: 'stelle lampe5 auf strohgelb', mode: 'execute' },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: stateId, value: '#f7e780' }]);
        const lila = await controller.process(
            { requestId: 'lila-first', text: 'stelle lampe5 auf lila', mode: 'execute' },
            'admin.0',
        );
        expect(lila.status).to.equal('success');
        expect(writes).to.deep.equal([
            { id: stateId, value: '#f7e780' },
            { id: stateId, value: '#800080' },
        ]);
    });

    it('asks for an unknown color name and then applies only a known color', async () => {
        const id = 'plug.0.rgb';
        const stateId = `${id}.COLOR`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Lampe' } },
            {
                id: stateId,
                type: 'state',
                common: { role: 'level.color.rgb', type: 'string', read: true, write: true },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.turnOff', '#808080');
        registry.setEnabled(id, true);
        registry.approve(id, stateId, 'setValue');
        const question = await controller.process(
            { requestId: 'unknown-color', text: 'Stelle die Lampe auf Quatschfarbe', mode: 'execute' },
            'admin.0',
        );
        expect(question.status).to.equal('clarification');
        expect(question.clarification?.key).to.equal('colorName');
        expect(writes).to.be.empty;
        const answer = await controller.process(
            { requestId: 'known-color', text: 'Lila', mode: 'execute', clarificationId: question.clarification!.id },
            'admin.0',
        );
        expect(answer.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: stateId, value: '#800080' }]);
    });

    it('converts a color-name answer for an RGB string state before writing', async () => {
        const id = 'test.0.lampe5';
        const stateId = `${id}.color`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Lampe5' } },
            {
                id: stateId,
                type: 'state',
                common: { name: 'Farbe', role: 'level.color.rgb', type: 'string', read: true, write: true },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.setValue', '#000000');
        registry.setEnabled(id, true);
        registry.approve(id, stateId, 'setValue');
        const question = await controller.process(
            { requestId: 'rgb-value-question', text: 'Setze den Wert von Lampe5', mode: 'execute' },
            'admin.0',
        );
        expect(question.clarification?.key).to.equal('value');
        const answer = await controller.process(
            {
                requestId: 'rgb-value-answer',
                text: 'Lila',
                mode: 'execute',
                clarificationId: question.clarification!.id,
            },
            'admin.0',
        );
        expect(answer.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: stateId, value: '#800080' }]);
        const secondQuestion = await controller.process(
            { requestId: 'rgb-value-question-2', text: 'Setze den Wert von Lampe5', mode: 'execute' },
            'admin.0',
        );
        const secondAnswer = await controller.process(
            {
                requestId: 'rgb-value-answer-2',
                text: 'Strohgelb',
                mode: 'execute',
                clarificationId: secondQuestion.clarification!.id,
            },
            'admin.0',
        );
        expect(secondAnswer.status).to.equal('success');
        expect(writes[1]).to.deep.equal({ id: stateId, value: '#f7e780' });
        const invalidQuestion = await controller.process(
            { requestId: 'rgb-value-question-3', text: 'Setze den Wert von Lampe5', mode: 'execute' },
            'admin.0',
        );
        const invalid = await controller.process(
            {
                requestId: 'rgb-value-invalid',
                text: 'blabla',
                mode: 'execute',
                clarificationId: invalidQuestion.clarification!.id,
            },
            'admin.0',
        );
        expect(invalid.status).to.equal('rejected');
        expect(invalid.errorCode).to.equal('INVALID_VALUE');
        expect(writes).to.have.length(2);
    });

    it('treats a complete color command as a new request during a color-name clarification', async () => {
        const id = 'test.0.lampe5';
        const stateId = `${id}.color`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'lampe5 ' } },
            {
                id: stateId,
                type: 'state',
                common: { name: 'Farbe', role: 'level.color.rgb', type: 'string', read: true, write: true },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.setTemperature', '#000000');
        registry.setEnabled(id, true);
        registry.approve(id, stateId, 'setValue');
        const question = await controller.process(
            { requestId: 'color-unknown', text: 'stelle lampe5 auf blabla', mode: 'execute' },
            'admin.0',
        );
        expect(question.clarification?.key).to.equal('colorName');
        const result = await controller.process(
            {
                requestId: 'color-restart',
                text: 'stelle lampe5 auf strohgelb',
                mode: 'execute',
                clarificationId: question.clarification!.id,
            },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: stateId, value: '#f7e780' }]);
        const analysisQuestion = await controller.process(
            { requestId: 'color-unknown-analyze', text: 'stelle lampe5 auf blabla', mode: 'analyze' },
            'admin.0',
        );
        const analysis = await controller.process(
            {
                requestId: 'color-restart-analyze',
                text: 'stelle lampe5 auf strohgelb',
                mode: 'analyze',
                clarificationId: analysisQuestion.clarification!.id,
            },
            'admin.0',
        );
        expect(analysis.status).to.equal('success');
        expect(analysis.actions?.[0].value).to.equal('#f7e780');
        expect(writes).to.have.length(1);
    });

    it('sets warm white in Kelvin and adjusts RGB saturation', async () => {
        const id = 'plug.0.light';
        const temperatureId = `${id}.TEMPERATURE`;
        const colorId = `${id}.COLOR`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Lampe' } },
            {
                id: temperatureId,
                type: 'state',
                common: {
                    role: 'level.color.temperature',
                    type: 'number',
                    read: true,
                    write: true,
                    min: 2200,
                    max: 6500,
                    unit: 'K',
                },
            },
            {
                id: colorId,
                type: 'state',
                common: { role: 'level.color.rgb', type: 'string', read: true, write: true },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.turnOff', '#804040');
        registry.setEnabled(id, true);
        registry.approve(id, temperatureId, 'setValue');
        registry.approve(id, colorId, 'setValue');
        const white = await controller.process(
            { requestId: 'warm-white', text: 'Stelle die Lampe auf Warmweiß', mode: 'analyze' },
            'admin.0',
        );
        expect(white.actions?.[0].value).to.equal(2200);
        const saturated = await controller.process(
            { requestId: 'saturate-rgb', text: 'Mach die Lampe etwas satter', mode: 'execute' },
            'admin.0',
        );
        expect(saturated.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: colorId, value: '#803a3a' }]);
    });

    it('uses only approved next and previous buttons for media changes', async () => {
        const id = 'plug.0.music';
        const nextId = `${id}.NEXT`;
        const previousId = `${id}.PREVIOUS`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Musik' } },
            { id: nextId, type: 'state', common: { role: 'button.next', type: 'boolean', write: true } },
            { id: previousId, type: 'state', common: { role: 'button.previous', type: 'boolean', write: true } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.turnOff');
        registry.setEnabled(id, true);
        registry.approve(id, nextId, 'press');
        const next = await controller.process(
            { requestId: 'media-next', text: 'Musik weiter', mode: 'analyze' },
            'admin.0',
        );
        expect(next.status).to.equal('success');
        expect(next.actions?.[0].stateId).to.equal(nextId);
        expect(writes).to.be.empty;
        const previous = await controller.process(
            { requestId: 'media-previous', text: 'Musik zurück', mode: 'execute' },
            'admin.0',
        );
        expect(previous.status).not.to.equal('success');
        expect(writes).to.be.empty;
        registry.approve(id, previousId, 'press');
        const approved = await controller.process(
            { requestId: 'media-previous-approved', text: 'Musik zurück', mode: 'execute' },
            'admin.0',
        );
        expect(approved.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: previousId, value: true }]);
    });

    it('rejects an approved but unsupported CIE color format explicitly', async () => {
        const id = 'plug.0.cie';
        const stateId = `${id}.COLOR`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Lampe' } },
            {
                id: stateId,
                type: 'state',
                common: { role: 'level.color.cie', type: 'string', read: true, write: true },
            },
        ];
        const { registry, controller, writes } = fixture(objects);
        registry.setEnabled(id, true);
        registry.approve(id, stateId, 'setValue');
        const result = await controller.process(
            { requestId: 'cie-color', text: 'Stelle Lampe auf Lila', mode: 'execute' },
            'admin.0',
        );
        expect(result.errorCode).to.equal('COLOR_FORMAT_UNSUPPORTED');
        expect(writes).to.be.empty;
    });

    it('reports the Lampe5 room conflict and missing color approval before asking for a color', async () => {
        const lamp5 = 'test.0.lampe5';
        const colorId = `${lamp5}.color`;
        const objects: ObjectSnapshot[] = [
            { id: 'test.0.lampe', type: 'channel', common: { name: 'Lampe' } },
            {
                id: 'test.0.lampe.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            { id: lamp5, type: 'channel', common: { name: 'lampe5 ' } },
            {
                id: colorId,
                type: 'state',
                common: { name: 'Farbe', role: 'level.color.rgb', type: 'string', read: true, write: true },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { name: 'Wohnzimmer', members: ['test.0.lampe'] } },
            { id: 'enum.rooms.lampenzimmer', type: 'enum', common: { name: 'Lampenzimmer', members: [lamp5] } },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.setTemperature', '#000000', undefined, 0.71);
        const mismatch = await controller.process(
            { requestId: 'lamp5-wrong-room', text: 'Stelle Lampe5 im Wohnzimmer auf Farbe blabla', mode: 'analyze' },
            'admin.0',
        );
        expect(mismatch.errorCode).to.equal('DEVICE_ROOM_MISMATCH');
        expect(mismatch.response).to.include('Lampenzimmer');
        expect(
            mismatch.analysis?.entities?.some(
                entity => entity.type === 'room' && String(entity.value).toLocaleLowerCase() === 'wohnzimmer',
            ),
        ).to.equal(true);
        expect(mismatch.analysis?.devices?.find(item => item.deviceId === lamp5)).to.include({
            nameMatched: true,
            roomMatched: false,
        });
        const unapproved = await controller.process(
            { requestId: 'lamp5-unapproved', text: 'Stelle Lampe5 im Lampenzimmer auf Farbe blabla', mode: 'analyze' },
            'admin.0',
        );
        expect(unapproved.errorCode).to.equal('ACTION_NOT_APPROVED');
        registry.setEnabled(lamp5, true);
        registry.approve(lamp5, colorId, 'setValue');
        const question = await controller.process(
            { requestId: 'lamp5-approved', text: 'Stelle Lampe5 im Lampenzimmer auf Farbe blabla', mode: 'execute' },
            'admin.0',
        );
        expect(question.clarification?.key).to.equal('colorName');
        const answer = await controller.process(
            { requestId: 'lamp5-answer', text: 'Lila', mode: 'execute', clarificationId: question.clarification!.id },
            'admin.0',
        );
        expect(answer.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: colorId, value: '#800080' }]);
    });

    it('answers room, device and function inventory using only approved devices', async () => {
        const objects: ObjectSnapshot[] = [
            {
                id: 'enum.rooms.wohnzimmer',
                type: 'enum',
                common: { name: 'Wohnzimmer', members: ['plug.0.lamp', 'plug.0.hidden'] },
            },
            {
                id: 'enum.rooms.schlafzimmer',
                type: 'enum',
                common: { name: 'Schlafzimmer', members: ['plug.0.sensor'] },
            },
            ...lamp,
            { id: 'plug.0.hidden', type: 'device', common: { name: 'Versteckt' } },
            {
                id: 'plug.0.hidden.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            { id: 'plug.0.sensor', type: 'device', common: { name: 'Sensor' } },
            {
                id: 'plug.0.sensor.TEMP',
                type: 'state',
                common: { name: 'Temperatur', role: 'value', type: 'number', read: true, write: false },
            },
        ];
        const { registry, controller } = fixture(objects, 'device.listRooms');
        registry.setEnabled('plug.0.lamp', true);
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        registry.setEnabled('plug.0.sensor', true);
        registry.approve('plug.0.sensor', 'plug.0.sensor.TEMP', 'getValue');
        const rooms = await controller.process(
            { requestId: 'cat1', text: 'Welche Räume kennst du', mode: 'execute' },
            'admin.0',
        );
        expect(rooms.status).to.equal('success');
        expect(rooms.response).to.include('Wohnzimmer').and.include('Schlafzimmer');
        const devicesController = fixture(objects, 'device.listDevices');
        devicesController.registry.setEnabled('plug.0.lamp', true);
        devicesController.registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const devices = await devicesController.controller.process(
            { requestId: 'cat2', text: 'Welche Geräte sind im Wohnzimmer', mode: 'analyze' },
            'admin.0',
        );
        expect(devices.response).to.include('Lampe');
        expect(devices.response).not.to.include('Versteckt');
        const functionsController = fixture(objects, 'device.listFunctions');
        functionsController.registry.setEnabled('plug.0.lamp', true);
        functionsController.registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const functions = await functionsController.controller.process(
            { requestId: 'cat3', text: 'Welche Funktionen hat die Lampe im Wohnzimmer', mode: 'execute' },
            'admin.0',
        );
        expect(functions.response).to.include('Schalten');
    });

    it('confirms a similar room before answering or executing', async () => {
        const objects: ObjectSnapshot[] = [
            ...lamp,
            {
                id: 'enum.rooms.wohnzimmer',
                type: 'enum',
                common: { name: { de: 'Wohnzimmer', en: 'Living room' }, members: ['plug.0.lamp'] },
            },
        ];
        const catalog = fixture(objects, 'device.listDevices');
        catalog.registry.setEnabled('plug.0.lamp', true);
        catalog.registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const question = await catalog.controller.process(
            { requestId: 'room-similar-catalog', text: 'Welche Geräte gibt es im Bodenzimmer', mode: 'execute' },
            'admin.0',
        );
        expect(question.clarification?.key).to.equal('room');
        expect(question.response).to.equal('Meintest du den Raum Wohnzimmer?');
        const answer = await catalog.controller.process(
            {
                requestId: 'room-similar-catalog-answer',
                text: 'ja',
                mode: 'execute',
                clarificationId: question.clarification!.id,
            },
            'admin.0',
        );
        expect(answer.status).to.equal('success');
        expect(answer.response).to.include('Lampe');
        const english = await catalog.controller.process(
            {
                requestId: 'room-similar-english',
                text: 'Which devices are in the Lving room',
                language: 'en',
                mode: 'analyze',
            },
            'admin.0',
        );
        expect(english.response).to.equal('Did you mean the room Living room?');

        const command = fixture(objects);
        command.registry.setEnabled('plug.0.lamp', true);
        command.registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const pending = await command.controller.process(
            { requestId: 'room-similar-action', text: 'Schalte die Lampe im Bodenzimmer ein', mode: 'execute' },
            'admin.0',
        );
        expect(pending.clarification?.key).to.equal('room');
        expect(command.writes).to.be.empty;
        const executed = await command.controller.process(
            {
                requestId: 'room-similar-action-answer',
                text: 'Wohnzimmer',
                mode: 'execute',
                clarificationId: pending.clarification!.id,
            },
            'admin.0',
        );
        expect(executed.status).to.equal('success');
        expect(command.writes).to.deep.equal([{ id: 'plug.0.lamp.POWER', value: true }]);
    });

    it('confirms similar device and data point names', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'plug.0.blind', type: 'device', common: { name: 'Rolladen' } },
            {
                id: 'plug.0.blind.LAMELLEN',
                type: 'state',
                common: { name: 'Lamellen', role: 'value', type: 'number', read: true, write: false },
            },
            {
                id: 'plug.0.blind.POSITION',
                type: 'state',
                common: { name: 'Position', role: 'value', type: 'number', read: true, write: false },
            },
            {
                id: 'enum.rooms.wohnzimmer',
                type: 'enum',
                common: { name: 'Wohnzimmer', members: ['plug.0.blind'] },
            },
        ];
        const test = fixture(objects, 'device.getValue', 50);
        test.registry.setEnabled('plug.0.blind', true);
        test.registry.approve('plug.0.blind', 'plug.0.blind.LAMELLEN', 'getValue');
        test.registry.approve('plug.0.blind', 'plug.0.blind.POSITION', 'getValue');
        const device = await test.controller.process(
            { requestId: 'similar-device', text: 'Welchen Wert hat Roladen im Wohnzimmer', mode: 'execute' },
            'admin.0',
        );
        expect(device.clarification?.key).to.equal('device');
        expect(device.response).to.include('Meintest du das Gerät Rolladen');
        const capability = await test.controller.process(
            { requestId: 'similar-function', text: 'Welchen Wert haben die Lamelen im Wohnzimmer', mode: 'execute' },
            'admin.0',
        );
        expect(capability.clarification?.key).to.equal('capability');
        expect(capability.response).to.equal('Meintest du die Funktion Lamellen?');
        const answer = await test.controller.process(
            {
                requestId: 'similar-function-answer',
                text: 'ja',
                mode: 'execute',
                clarificationId: capability.clarification!.id,
            },
            'admin.0',
        );
        expect(answer.status).to.equal('success');
        expect(answer.actions?.[0].stateId).to.equal('plug.0.blind.LAMELLEN');
    });

    it('confirms a similar ioBroker function before switching', async () => {
        const objects: ObjectSnapshot[] = [
            ...lamp,
            {
                id: 'enum.rooms.wohnzimmer',
                type: 'enum',
                common: { name: 'Wohnzimmer', members: ['plug.0.lamp'] },
            },
            {
                id: 'enum.functions.licht',
                type: 'enum',
                common: { name: 'Licht', members: ['plug.0.lamp'] },
            },
        ];
        const { registry, controller, writes } = fixture(objects);
        registry.setEnabled('plug.0.lamp', true);
        registry.approve('plug.0.lamp', 'plug.0.lamp.POWER', 'turnOn');
        const question = await controller.process(
            { requestId: 'function-similar', text: 'Schalte Lichd im Wohnzimmer ein', mode: 'execute' },
            'admin.0',
        );
        expect(question.response).to.equal('Meintest du die Funktion Licht?');
        expect(writes).to.be.empty;
        const answer = await controller.process(
            {
                requestId: 'function-similar-answer',
                text: 'ja',
                mode: 'execute',
                clarificationId: question.clarification!.id,
            },
            'admin.0',
        );
        expect(answer.status).to.equal('success');
        expect(writes).to.deep.equal([{ id: 'plug.0.lamp.POWER', value: true }]);
    });

    it('continues a function inventory query after room and device selections', async () => {
        const objects: ObjectSnapshot[] = [
            {
                id: 'enum.rooms.wohnzimmer',
                type: 'enum',
                common: { name: 'Wohnzimmer', members: ['plug.0.lamp', 'plug.0.fan'] },
            },
            {
                id: 'enum.rooms.schlafzimmer',
                type: 'enum',
                common: { name: 'Schlafzimmer', members: ['plug.0.sensor'] },
            },
            ...lamp,
            { id: 'plug.0.fan', type: 'device', common: { name: 'Ventilator' } },
            {
                id: 'plug.0.fan.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            { id: 'plug.0.sensor', type: 'device', common: { name: 'Sensor' } },
            {
                id: 'plug.0.sensor.TEMP',
                type: 'state',
                common: { name: 'Temperatur', role: 'value', type: 'number', read: true, write: false },
            },
        ];
        const { registry, controller } = fixture(objects, 'device.listFunctions');
        for (const id of ['plug.0.lamp', 'plug.0.fan']) {
            registry.setEnabled(id, true);
            registry.approve(id, `${id}.POWER`, 'turnOn');
        }
        registry.setEnabled('plug.0.sensor', true);
        registry.approve('plug.0.sensor', 'plug.0.sensor.TEMP', 'getValue');
        const first = await controller.process(
            { requestId: 'cat4', sessionId: 's1', text: 'Welche Funktionen kennst du', mode: 'execute' },
            'admin.0',
        );
        expect(first.clarification?.key).to.equal('room');
        const second = await controller.process(
            {
                requestId: 'cat5',
                sessionId: 's1',
                clarificationId: first.clarification!.id,
                text: 'Wohnzimmer',
                mode: 'execute',
            },
            'admin.0',
        );
        expect(second.clarification?.key).to.equal('device');
        const third = await controller.process(
            {
                requestId: 'cat6',
                sessionId: 's1',
                clarificationId: second.clarification!.id,
                text: 'Ventilator',
                mode: 'execute',
            },
            'admin.0',
        );
        expect(third.status).to.equal('success');
        expect(third.response).to.include('Ventilator').and.include('Schalten');
    });

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
            {
                id: 'enum.functions.licht',
                type: 'enum',
                common: { name: 'Licht', members: ['plug.0.wohnzimmer', 'plug.0.schlafzimmer'] },
            },
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
        expect(result.analysis?.functions?.find(item => item.deviceId === 'plug.0.wohnzimmer')).to.include({
            name: 'Licht',
        });
        expect(result.analysis?.dataPoints?.find(item => item.deviceId === 'plug.0.wohnzimmer')).to.include({
            stateId: 'plug.0.wohnzimmer.POWER',
            actionAllowed: true,
        });
        expect(writes).to.be.empty;
    });

    it('shows device name matches and asks for the missing switch direction', async () => {
        const objects: ObjectSnapshot[] = [
            { id: 'plug.0.living', type: 'channel', common: { name: 'Lampe' } },
            { id: 'plug.0.standing', type: 'channel', common: { name: 'Stehlampe' } },
            {
                id: 'plug.0.living.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            {
                id: 'plug.0.standing.POWER',
                type: 'state',
                common: { role: 'switch', type: 'boolean', read: true, write: true },
            },
            {
                id: 'enum.rooms.wohnzimmer',
                type: 'enum',
                common: { members: ['plug.0.living', 'plug.0.standing'] },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.turnOff', true, undefined, 0.628);
        for (const id of ['plug.0.living', 'plug.0.standing']) {
            registry.setEnabled(id, true);
            registry.approve(id, `${id}.POWER`, 'turnOn');
            registry.approve(id, `${id}.POWER`, 'turnOff');
        }
        const text = 'schalte lampe im wohnzimmer';
        const first = await controller.process({ requestId: 'direction-1', text, mode: 'analyze' }, 'admin.0');
        expect(first.status).to.equal('clarification');
        expect(first.clarification?.key).to.equal('action');
        expect(first.response).to.include('einschalten oder ausschalten');
        expect(first.analysis?.devices?.find(item => item.deviceId === 'plug.0.living')).to.include({
            deviceName: 'Lampe',
            nameMatched: true,
            roomMatched: true,
        });
        expect(first.analysis?.devices?.find(item => item.deviceId === 'plug.0.standing')).to.include({
            deviceName: 'Stehlampe',
            nameMatched: false,
            roomMatched: true,
        });
        expect(writes).to.be.empty;

        const chosen = await controller.process(
            {
                requestId: 'direction-2',
                text: 'ein',
                mode: 'analyze',
                clarificationId: first.clarification!.id,
                selection: 'turnOn',
            },
            'admin.0',
        );
        expect(chosen.status).to.equal('success');
        expect(chosen.intent).to.equal('device.turnOn');
        expect(chosen.actions?.[0].deviceId).to.equal('plug.0.living');
        expect(writes).to.be.empty;

        const execute = await controller.process({ requestId: 'direction-3', text, mode: 'execute' }, 'admin.0');
        expect(execute.clarification?.key).to.equal('action');
        expect(writes).to.be.empty;
        const unclear = await controller.process(
            {
                requestId: 'direction-unclear',
                text: 'vielleicht',
                mode: 'execute',
                clarificationId: execute.clarification!.id,
            },
            'admin.0',
        );
        expect(unclear.clarification?.key).to.equal('action');
        expect(writes).to.be.empty;
        const switchedOff = await controller.process(
            {
                requestId: 'direction-4',
                text: 'aus',
                mode: 'execute',
                clarificationId: execute.clarification!.id,
            },
            'admin.0',
        );
        expect(switchedOff.status).to.equal('success');
        expect(switchedOff.intent).to.equal('device.turnOff');
        expect(writes).to.deep.equal([{ id: 'plug.0.living.POWER', value: false }]);
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
        expect(value.response).to.equal('Der Wert für IST von Sensor im Raum Wohnzimmer beträgt 21 °C.');
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
        const diagnostic = await controller.process(
            { ...request, requestId: 'climate-diagnostic', mode: 'analyze' },
            'admin.0',
        );
        expect(diagnostic.analysis?.dataPoints?.map(item => item.stateId)).to.include('test.0.climate.boost');
        expect(
            diagnostic.analysis?.dataPoints?.find(item => item.stateId === 'test.0.climate.boost')?.actionAllowed,
        ).to.equal(false);

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
        const spoken = await write.controller.process(
            {
                requestId: 'blind-write-spoken',
                text: 'Stelle den Rollladen im Wohnzimmer auf fünfundsiebzig Prozent',
                mode: 'execute',
            },
            'admin.0',
        );
        expect(spoken.status).to.equal('success');
        expect(write.writes.at(-1)).to.deep.equal({ id: `${id}.POSITION`, value: 75 });
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
        expect(measured.response).to.include('Lamellen');
        const namedSlats = await read.controller.process(
            { requestId: 'blind-slats-named', text: 'Welchen Wert hat die Lamellen im Wohnzimmer', mode: 'execute' },
            'admin.0',
        );
        expect(namedSlats.status).to.equal('success');
        expect(namedSlats.actions?.[0].stateId).to.equal(`${id}.TILT`);
        expect(namedSlats.response).to.include('Lamellen');
        const explicitPosition = await read.controller.process(
            {
                requestId: 'blind-position-explicit',
                text: 'Welchen Wert hat die Position des Geräts Rollladen im Wohnzimmer',
                mode: 'execute',
            },
            'admin.0',
        );
        expect(explicitPosition.status).to.equal('success');
        expect(explicitPosition.actions?.[0].stateId).to.equal(`${id}.POSITION`);
        expect(explicitPosition.response).to.include('Position');
        const ambiguous = await read.controller.process(
            { requestId: 'blind-value-ambiguous', text: 'Welchen Wert hat Roladen im Wohnzimmer', mode: 'execute' },
            'admin.0',
        );
        expect(ambiguous.clarification?.key).to.equal('device');
        expect(ambiguous.response).to.include('Meintest du das Gerät Rollladen');
        const confirmedDevice = await read.controller.process(
            {
                requestId: 'blind-device-confirmed',
                text: 'ja',
                mode: 'execute',
                clarificationId: ambiguous.clarification!.id,
            },
            'admin.0',
        );
        expect(confirmedDevice.clarification?.key).to.equal('capability');
        expect(confirmedDevice.clarification?.options?.map(option => option.label)).to.deep.equal([
            'Position',
            'Lamellen',
        ]);
        const selected = await read.controller.process(
            {
                requestId: 'blind-value-selected',
                text: 'Position',
                mode: 'execute',
                clarificationId: confirmedDevice.clarification!.id,
            },
            'admin.0',
        );
        expect(selected.status).to.equal('success');
        expect(selected.actions?.[0].stateId).to.equal(`${id}.POSITION`);
        expect(selected.response).to.include('Position');
    });

    it('asks for a missing value after resolving a named function and asks for the device when needed', async () => {
        const blind = 'test.0.blind';
        const other = 'test.0.otherBlind';
        const objects: ObjectSnapshot[] = [
            { id: blind, type: 'channel', common: { name: 'Rolladen' } },
            {
                id: `${blind}.lamellen`,
                type: 'state',
                common: { name: 'Lamellen', role: 'value', type: 'number', read: true, write: true, unit: '%' },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { name: 'Wohnzimmer', members: [blind] } },
        ];
        const single = fixture(objects, 'device.getValue', 0, undefined, 0.55);
        single.registry.setEnabled(blind, true);
        single.registry.approve(blind, `${blind}.lamellen`, 'setValue');
        const commands = [
            'Setze den Wert der Lamellen des Geräts Rolladen im Wohnzimmer',
            'Stelle den Wert der Lamellen des Rolladens im Wohnzimmer',
            'Setze am Gerät Rolladen im Wohnzimmer den Wert von Lamellen',
            'Setze den Wert der Lamellen im Wohnzimmer',
        ];
        let lastQuestion: Awaited<ReturnType<typeof single.controller.process>> | undefined;
        for (const [index, command] of commands.entries()) {
            lastQuestion = await single.controller.process(
                { requestId: `missing-value-${index}`, text: command, mode: 'execute' },
                'admin.0',
            );
            expect(lastQuestion.intent).to.equal('device.setValue');
            expect(lastQuestion.clarification?.key).to.equal('value');
        }
        const completed = await single.controller.process(
            {
                requestId: 'missing-value-answer',
                text: '50 Prozent',
                mode: 'execute',
                clarificationId: lastQuestion!.clarification!.id,
            },
            'admin.0',
        );
        expect(completed.status).to.equal('success');
        expect(single.writes).to.deep.equal([{ id: `${blind}.lamellen`, value: 50 }]);

        const multiple = fixture(
            [
                ...objects.slice(0, 2),
                { id: other, type: 'channel', common: { name: 'Jalousie' } },
                {
                    id: `${other}.lamellen`,
                    type: 'state',
                    common: { name: 'Lamellen', role: 'value', type: 'number', read: true, write: true, unit: '%' },
                },
                { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { name: 'Wohnzimmer', members: [blind, other] } },
            ],
            'device.getValue',
            0,
            undefined,
            0.55,
        );
        for (const id of [blind, other]) {
            multiple.registry.setEnabled(id, true);
            multiple.registry.approve(id, `${id}.lamellen`, 'setValue');
        }
        const deviceQuestion = await multiple.controller.process(
            { requestId: 'missing-device', text: commands[3], mode: 'execute' },
            'admin.0',
        );
        expect(deviceQuestion.clarification?.key).to.equal('device');
        const valueQuestion = await multiple.controller.process(
            {
                requestId: 'chosen-device',
                text: 'Rolladen',
                mode: 'execute',
                clarificationId: deviceQuestion.clarification!.id,
            },
            'admin.0',
        );
        expect(valueQuestion.clarification?.key).to.equal('value');
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

    it('uses a uniquely named approved numeric state when the NLP intent is uncertain', async () => {
        const id = 'test.0.blind';
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Rolladen' } },
            {
                id: `${id}.position`,
                type: 'state',
                common: { name: 'Position', role: 'level.tilt', type: 'number', read: true, write: true, unit: '%' },
            },
            {
                id: `${id}.lamellen`,
                type: 'state',
                common: {
                    name: { de: 'Lamellen', en: 'Slats' },
                    role: 'level.tilt',
                    type: 'number',
                    read: true,
                    write: true,
                    unit: '%',
                },
            },
            {
                id: 'enum.rooms.wohnzimmer',
                type: 'enum',
                common: { name: { de: 'Wohnzimmer', en: 'Living room' }, members: [id] },
            },
        ];
        const { registry, controller, writes } = fixture(objects, 'device.setValue', 0, undefined, 0.594);
        registry.setEnabled(id, true);
        registry.approve(id, `${id}.position`, 'setValue');
        registry.approve(id, `${id}.lamellen`, 'setValue');

        const result = await controller.process(
            { requestId: 'low-confidence-slats', text: 'stelle die lamellen in wohnzimmer auf 50%', mode: 'execute' },
            'admin.0',
        );
        expect(result.status).to.equal('success');
        expect(result.intent).to.equal('device.setValue');
        expect(result.confidence).to.equal(0.594);
        expect(result.actions?.[0].stateId).to.equal(`${id}.lamellen`);
        expect(writes).to.deep.equal([{ id: `${id}.lamellen`, value: 50 }]);

        const english = await controller.process(
            {
                requestId: 'low-confidence-slats-en',
                text: 'set the slats in the living room to 35%',
                language: 'en',
                mode: 'analyze',
            },
            'admin.0',
        );
        expect(english.status).to.equal('success');
        expect(english.actions?.[0].stateId).to.equal(`${id}.lamellen`);

        const ambiguous = await controller.process(
            { requestId: 'low-confidence-ambiguous', text: 'stelle im wohnzimmer auf 50%', mode: 'analyze' },
            'admin.0',
        );
        expect(ambiguous.errorCode).to.equal('UNCLEAR_INTENT');

        registry.revoke(id, `${id}.lamellen`, 'setValue');
        const unapproved = await controller.process(
            {
                requestId: 'low-confidence-unapproved',
                text: 'stelle die lamellen in wohnzimmer auf 50%',
                mode: 'analyze',
            },
            'admin.0',
        );
        expect(unapproved.errorCode).to.equal('UNCLEAR_INTENT');
    });

    it('writes only the trailing free text of an approved custom string intent', async () => {
        const id = '0_userdata.0.test_musik_wohnzimmer';
        const stateId = `${id}.Favorit`;
        const objects: ObjectSnapshot[] = [
            { id, type: 'channel', common: { name: 'Musik' } },
            {
                id: stateId,
                type: 'state',
                common: { name: 'Favorit', role: 'value', type: 'string', read: true, write: true },
            },
            { id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: [id] } },
        ];
        const custom: IntentDefinition = {
            id: 'FavoritSpielen',
            source: 'user',
            enabled: true,
            utterances: {
                de: ['Spiele Favorit', 'Starte Favorit'],
                en: ['Play favorite', 'Start favorite'],
            },
            action: { kind: 'capability', operation: 'setValue' },
        };
        const { registry, controller, writes } = fixture(objects, custom.id, '', undefined, 0.56, [custom]);
        registry.setEnabled(id, true);
        registry.approve(id, stateId, 'setValue');

        const analysis = await controller.process(
            { requestId: 'favorite-analyze', text: 'Spiele Favorit SWR', mode: 'analyze' },
            'admin.0',
        );
        expect(analysis.status).to.equal('success');
        expect(analysis.analysis?.plan).to.include({ stateId, value: 'SWR' });
        expect(writes).to.be.empty;

        const misclassified = fixture(objects, 'device.turnOn', '', undefined, 0.95, [custom]);
        misclassified.registry.setEnabled(id, true);
        misclassified.registry.approve(id, stateId, 'setValue');
        const inactive = await misclassified.controller.process(
            { requestId: 'favorite-override', text: 'Spiele Favorit SWR', mode: 'analyze' },
            'admin.0',
        );
        expect(inactive.status).to.equal('rejected');
        expect(inactive.analysis?.plan).to.be.undefined;

        const executed = await controller.process(
            { requestId: 'favorite-execute', text: 'Spiele Favorit SWR', mode: 'execute' },
            'admin.0',
        );
        expect(executed.status).to.equal('success');
        expect(executed.response).to.include('SWR');
        expect(writes).to.deep.equal([{ id: stateId, value: 'SWR' }]);

        const withNumber = await controller.process(
            { requestId: 'favorite-number-in-name', text: 'Spiele Favorit SWR 3', mode: 'analyze' },
            'admin.0',
        );
        expect(withNumber.analysis?.plan?.value).to.equal('SWR 3');
        expect(withNumber.response).to.include('SWR 3');

        const question = await controller.process(
            { requestId: 'favorite-question', sessionId: 'favorite', text: 'Spiele Favorit', mode: 'execute' },
            'admin.0',
        );
        expect(question.clarification?.key).to.equal('value');
        const answer = await controller.process(
            {
                requestId: 'favorite-answer',
                sessionId: 'favorite',
                clarificationId: question.clarification?.id,
                text: 'WDR',
                mode: 'execute',
            },
            'admin.0',
        );
        expect(answer.status).to.equal('success');
        expect(writes.at(-1)).to.deep.equal({ id: stateId, value: 'WDR' });

        registry.revoke(id, stateId, 'setValue');
        const denied = await controller.process(
            { requestId: 'favorite-unapproved', text: 'Spiele Favorit SWR', mode: 'execute' },
            'admin.0',
        );
        expect(denied.status).to.equal('rejected');
        expect(writes).to.have.length(2);
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
