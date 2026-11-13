import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRouter } from '../src/api/MessageRouter';
import { CommandController } from '../src/commands/CommandController';
import { DeviceCatalog } from '../src/devices/DeviceCatalog';
import { discoverDevices } from '../src/devices/DeviceDiscovery';
import { IntentRepository } from '../src/nlp/IntentRepository';
import { ModelRepository } from '../src/nlp/ModelRepository';
import type { IntentDefinition } from '../src/nlp/types';
import { AuditRepository } from '../src/storage/AuditRepository';
import { DeviceRepository } from '../src/storage/DeviceRepository';
import { TestLabHistoryRepository } from '../src/storage/TestLabHistoryRepository';
import { testAdapterTimers } from './AdapterTimers';

describe('message API', () => {
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'smart-text2command-api-'));
    });
    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it('blocks management from non-admin callers and applies explicit approval', async () => {
        const catalog = await DeviceCatalog.load(new DeviceRepository(join(directory, 'devices.json')));
        await catalog.reconcile(
            discoverDevices([
                { id: 'plug.0.lamp', type: 'device', common: { name: 'Lampe' } },
                {
                    id: 'plug.0.lamp.POWER',
                    type: 'state',
                    common: { role: 'switch', type: 'boolean', read: true, write: true },
                },
                { id: 'enum.rooms.living', type: 'enum', common: { name: 'Wohnzimmer', members: ['plug.0.lamp'] } },
                {
                    id: 'enum.functions.light',
                    type: 'enum',
                    common: { name: { de: 'Licht', en: 'Light' }, members: ['plug.0.lamp'] },
                },
            ]),
        );
        const controller = new CommandController(
            catalog,
            {
                getObject: () => Promise.resolve(undefined),
                getState: () => Promise.resolve(undefined),
                setState: () => Promise.reject(new Error('Unexpected write')),
            },
            () => undefined,
            () => [],
            new AuditRepository(join(directory, 'audit.json')),
        );
        let userIntents: IntentDefinition[] = [];
        let rescanCount = 0;
        const router = new MessageRouter({
            controller,
            catalog,
            intentRepository: new IntentRepository(join(directory, 'intents.json')),
            modelRepository: new ModelRepository(join(directory, 'models')),
            testLabHistory: new TestLabHistoryRepository(join(directory, 'test-lab-history.json')),
            timers: testAdapterTimers,
            getUserIntents: () => userIntents,
            setUserIntents: intents => {
                userIntents = intents;
            },
            setModel: () => undefined,
            modelReady: () => true,
            rescanDevices: () => {
                rescanCount++;
                return Promise.resolve();
            },
            isAdmin: context =>
                Promise.resolve(context.from === 'system.adapter.admin.0' && context.user === 'system.user.admin'),
            diagnostics: () => ({ status: 'ready' }),
        });
        const untrusted = { from: 'system.adapter.web.0', user: 'system.user.admin' };
        const admin = { from: 'system.adapter.admin.0', user: 'system.user.admin' };
        expect(await router.handle('listDevices', {}, untrusted)).to.deep.equal({ error: 'ADMIN_REQUIRED' });
        expect(await router.handle('listTestLabSessions', {}, untrusted)).to.deep.equal({ error: 'ADMIN_REQUIRED' });
        expect(
            await router.handle(
                'processTestLab',
                {
                    requestId: 'unauthorized-history',
                    sessionId: 'session-a',
                    text: 'Schalte Lampe ein',
                    mode: 'analyze',
                },
                untrusted,
            ),
        ).to.deep.equal({ error: 'ADMIN_REQUIRED' });
        const testLabResult = await router.handle(
            'processTestLab',
            { requestId: 'history-1', sessionId: 'session-a', text: 'Schalte Lampe ein', mode: 'analyze' },
            admin,
        );
        expect(testLabResult).to.have.property('requestId', 'history-1');
        const savedHistory = await router.handle('getTestLabSession', { sessionId: 'session-a' }, admin);
        expect(savedHistory).to.have.nested.property('session.exchanges[0].request.text', 'Schalte Lampe ein');
        expect(await router.handle('rescanDevices', {}, untrusted)).to.deep.equal({ error: 'ADMIN_REQUIRED' });
        expect(await router.handle('rescanDevices', {}, admin)).to.deep.equal({ status: 'updated' });
        expect(rescanCount).to.equal(1);
        expect(
            await router.handle('updateDevice', { deviceId: 'plug.0.lamp', enabled: true }, untrusted),
        ).to.deep.equal({ error: 'ADMIN_REQUIRED' });
        expect(catalog.list()[0].enabled).to.equal(false);
        await router.handle(
            'updateDevice',
            {
                deviceId: 'plug.0.lamp',
                enabled: true,
                approval: { stateId: 'plug.0.lamp.POWER', action: 'turnOn', approved: true },
            },
            admin,
        );
        const device = catalog.list()[0];
        expect(device.enabled).to.equal(true);
        expect(Object.keys(device.approvedCapabilities)).to.deep.equal(['turnOn:plug.0.lamp.POWER']);
        const listed = (await router.handle('listDevices', { limit: 1 }, admin)) as { total: number };
        expect(listed.total).to.equal(1);
        expect(await router.handle('listDevices', { functionId: 'enum.functions.light' }, admin)).to.include({
            total: 1,
        });
        expect(await router.handle('listDevices', { functionId: 'enum.functions.heating' }, admin)).to.include({
            total: 0,
        });
        const options = (await router.handle('listDevices', {}, admin)) as {
            rooms: unknown[];
            functions: unknown[];
            devices: Array<{ enumNames: Record<string, unknown> }>;
        };
        expect(options.rooms).to.deep.equal([{ id: 'enum.rooms.living', name: 'Wohnzimmer' }]);
        expect(options.functions).to.deep.equal([{ id: 'enum.functions.light', name: { de: 'Licht', en: 'Light' } }]);
        expect(options.devices[0].enumNames['enum.rooms.living']).to.equal('Wohnzimmer');

        expect(
            await router.handle(
                'updateDevice',
                {
                    deviceId: 'plug.0.lamp',
                    approvals: [
                        { stateId: 'plug.0.lamp.POWER', action: 'turnOff' },
                        { stateId: 'plug.0.lamp.POWER', action: 'setValue' },
                    ],
                },
                admin,
            ),
        ).to.have.property('error');
        expect(Object.keys(catalog.list()[0].approvedCapabilities)).to.deep.equal(['turnOn:plug.0.lamp.POWER']);
        await router.handle(
            'updateDevice',
            {
                deviceId: 'plug.0.lamp',
                approvals: [
                    { stateId: 'plug.0.lamp.POWER', action: 'turnOff' },
                    { stateId: 'plug.0.lamp.POWER', action: 'getState' },
                ],
            },
            admin,
        );
        expect(Object.keys(catalog.list()[0].approvedCapabilities)).to.deep.equal([
            'turnOn:plug.0.lamp.POWER',
            'turnOff:plug.0.lamp.POWER',
            'getState:plug.0.lamp.POWER',
        ]);
        expect(
            await router.handle(
                'updateDevice',
                {
                    deviceId: 'plug.0.lamp',
                    enabled: false,
                    revocations: [{ stateId: 'plug.0.lamp.POWER', action: 'turnOff' }],
                },
                admin,
            ),
        ).to.have.property('error');
        expect(catalog.list()[0].enabled).to.equal(true);
        await router.handle(
            'updateDevice',
            {
                deviceId: 'plug.0.lamp',
                revocations: [
                    { stateId: 'plug.0.lamp.POWER', action: 'turnOff' },
                    { stateId: 'plug.0.lamp.POWER', action: 'getState' },
                ],
            },
            admin,
        );
        expect(Object.keys(catalog.list()[0].approvedCapabilities)).to.deep.equal(['turnOn:plug.0.lamp.POWER']);
        await catalog.reconcile([
            ...catalog.list(),
            ...discoverDevices([{ id: 'plug.0.empty', type: 'device', common: { name: 'Ohne Datenpunkt' } }]),
        ]);
        for (const key of ['room', 'functionId']) {
            expect(await router.handle('listDevices', { [key]: '__none__' }, admin)).to.include({ total: 0 });
        }
        expect(await router.handle('listDevices', { capability: '__none__' }, admin)).to.include({ total: 0 });
        expect(await router.handle('listDevices', {}, admin)).to.include({ total: 1 });
        expect(await router.handle('listDevices', { capability: 'POWER' }, admin)).to.include({ total: 1 });
        await catalog.reconcile([]);
        expect(catalog.list().every(item => item.status === 'missing')).to.equal(true);
        expect(await router.handle('listDevices', { limit: 1 }, admin)).to.deep.equal({
            total: 0,
            devices: [],
            rooms: [],
            functions: [],
            capabilities: [],
        });
        await catalog.reconcile(
            discoverDevices([
                { id: 'test.0.heating', type: 'channel', common: { name: 'Heizung' } },
                {
                    id: 'test.0.heating.IST',
                    type: 'state',
                    common: { name: 'Temperatur', role: 'value.temperature', type: 'number', read: true, write: false },
                },
                {
                    id: 'test.0.heating.SOLL',
                    type: 'state',
                    common: {
                        name: 'Temperatur',
                        role: 'level.temperature',
                        type: 'number',
                        read: true,
                        write: true,
                        min: 5,
                        max: 30,
                    },
                },
                {
                    id: 'test.0.heating.POSITION',
                    type: 'state',
                    common: { role: 'value', type: 'number', read: true, write: false },
                },
            ]),
        );
        const named = (await router.handle('listDevices', { language: 'de' }, admin)) as { capabilities: string[] };
        expect(named.capabilities).to.deep.equal(['POSITION', 'Temperatur']);
        expect(await router.handle('listDevices', { capability: 'Temperatur' }, admin)).to.include({ total: 1 });
        expect(await router.handle('getDiagnostics', {}, admin)).to.deep.equal({ status: 'ready' });
        const imported: IntentDefinition[] = [
            {
                id: 'user.greeting',
                source: 'user',
                enabled: true,
                utterances: { de: ['Hallo'], en: ['Hello'] },
                action: { kind: 'response', response: { de: 'Hallo' } },
            },
        ];
        expect(await router.handle('importIntents', { schemaVersion: 1, intents: imported }, untrusted)).to.deep.equal({
            error: 'ADMIN_REQUIRED',
        });
        expect(await router.handle('importIntents', { schemaVersion: 1, intents: imported }, admin)).to.deep.equal({
            status: 'imported',
            count: 1,
        });
        expect(await new IntentRepository(join(directory, 'intents.json')).load()).to.deep.equal(imported);
        expect(await router.handle('exportIntents', {}, admin)).to.deep.equal({ schemaVersion: 1, intents: imported });
        const fixedSendTo: IntentDefinition = {
            id: 'user.fixedSendTo',
            source: 'user',
            enabled: true,
            utterances: { de: ['Sende Test', 'Starte Test'], en: ['Send test', 'Start test'] },
            action: {
                kind: 'sendTo',
                instance: 'javascript.0',
                command: 'toScript',
                payloadTemplate: {
                    script: 'script.js.testsendto',
                    message: 'meinBefehl',
                    data: { wert: 42, text: 'Hallo' },
                },
                parameters: [],
            },
        };
        expect(await router.handle('saveIntent', { intent: fixedSendTo }, admin)).to.deep.equal({
            status: 'saved',
            intentId: fixedSendTo.id,
        });
        expect((await new IntentRepository(join(directory, 'intents.json')).load()).at(-1)).to.deep.equal(fixedSendTo);
        const invalid = {
            ...fixedSendTo,
            action: { ...fixedSendTo.action, instance: 'invalid-target' },
        };
        expect(await router.handle('saveIntent', { intent: invalid }, admin)).to.deep.equal({
            error: 'Invalid sendTo instance',
        });
    });
});
