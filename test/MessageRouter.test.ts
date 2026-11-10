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
        const router = new MessageRouter({
            controller,
            catalog,
            intentRepository: new IntentRepository(join(directory, 'intents.json')),
            modelRepository: new ModelRepository(join(directory, 'models')),
            getUserIntents: () => userIntents,
            setUserIntents: intents => {
                userIntents = intents;
            },
            setModel: () => undefined,
            modelReady: () => true,
            isAdmin: context =>
                Promise.resolve(context.from === 'system.adapter.admin.0' && context.user === 'system.user.admin'),
            diagnostics: () => ({ status: 'ready' }),
        });
        const untrusted = { from: 'system.adapter.web.0', user: 'system.user.admin' };
        const admin = { from: 'system.adapter.admin.0', user: 'system.user.admin' };
        expect(await router.handle('listDevices', {}, untrusted)).to.deep.equal({ error: 'ADMIN_REQUIRED' });
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
        await catalog.reconcile([]);
        expect(catalog.list()[0].status).to.equal('missing');
        expect(await router.handle('listDevices', { limit: 1 }, admin)).to.deep.equal({
            total: 0,
            devices: [],
            rooms: [],
        });
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
    });
});
