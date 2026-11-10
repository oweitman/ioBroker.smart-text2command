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

    it('asks for a missing level and validates the selected value', async () => {
        const dimmer: ObjectSnapshot[] = [
            { id: 'dimmer.0.lamp', type: 'device', common: { name: 'Lampe' } },
            {
                id: 'dimmer.0.lamp.LEVEL',
                type: 'state',
                common: { role: 'level.dimmer', type: 'number', read: true, write: true, min: 0, max: 100 },
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
