import { expect } from 'chai';
import { AdminApi } from '../src/shared/AdminApi';

describe('admin adapter transport', () => {
    it('passes command payload and surfaces adapter rejection', async () => {
        const calls: Array<[string, Record<string, unknown>]> = [];
        const api = new AdminApi((command, payload) => {
            calls.push([command, payload]);
            return Promise.resolve(
                command === 'updateDevice' ? { error: 'ADMIN_REQUIRED' } : { total: 0, devices: [] },
            );
        });
        expect(await api.call('listDevices', { limit: 10 })).to.deep.equal({ total: 0, devices: [] });
        expect(calls).to.deep.equal([['listDevices', { limit: 10 }]]);
        try {
            await api.call('updateDevice', { deviceId: 'lamp' });
            throw new Error('Expected rejection');
        } catch (error) {
            expect((error as Error).message).to.equal('ADMIN_REQUIRED');
        }
    });
});
