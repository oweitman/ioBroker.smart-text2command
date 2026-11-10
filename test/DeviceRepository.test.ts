import { expect } from 'chai';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceRepository } from '../src/storage/DeviceRepository';
import { DeviceRegistry } from '../src/devices/DeviceRegistry';
import { discoverDevices } from '../src/devices/DeviceDiscovery';
import { DeviceCatalog } from '../src/devices/DeviceCatalog';

describe('device persistence', () => {
    it('keeps approvals and aliases across a restart and rejects tampering', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'smart-text2command-'));
        const file = join(dir, 'devices-v1.json');
        try {
            const repository = new DeviceRepository(file);
            const catalog = await DeviceCatalog.load(repository);
            await catalog.reconcile(
                discoverDevices([
                    {
                        id: 'plug.0.POWER',
                        type: 'state',
                        common: { role: 'switch', type: 'boolean', read: true, write: true },
                    },
                ]),
            );
            await catalog.setEnabled('plug.0.POWER', true);
            await catalog.approve('plug.0.POWER', 'plug.0.POWER', 'turnOn');
            await catalog.setAliases('plug.0.POWER', { de: ['Steckdose'] });
            const restored = await DeviceCatalog.load(repository);
            const device = restored.list()[0];
            expect(device.aliases.de).to.deep.equal(['Steckdose']);
            expect(
                new DeviceRegistry(await repository.load()).isAllowed(
                    device.id,
                    device.discoveredCapabilities[0],
                    'turnOn',
                ),
            ).to.equal(true);
            const raw = await readFile(file, 'utf8');
            await writeFile(file, raw.replace('Steckdose', 'Manipuliert'));
            try {
                await repository.load();
                expect.fail('tampered data was accepted');
            } catch (error) {
                expect(String(error)).to.contain('Invalid device store');
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
