import type { AdapterTimers } from '../src/shared/AdapterTimers';

export const testAdapterTimers: AdapterTimers = {
    setTimeout: (callback, timeout) => globalThis.setTimeout(callback, timeout) as unknown as ioBroker.Timeout,
    clearTimeout: timer => {
        if (timer) {
            globalThis.clearTimeout(timer as unknown as NodeJS.Timeout);
        }
    },
};
