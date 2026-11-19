import type { DeviceRecord } from './types';

export function isVisibleDevice(device: DeviceRecord): boolean {
    return (
        device.status !== 'missing' &&
        device.discoveredCapabilities.length > 0 &&
        (device.roomIds.length > 0 || device.functionIds.length > 0)
    );
}
