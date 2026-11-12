export interface AdapterTimers {
    setTimeout(callback: () => void, timeout: number): ioBroker.Timeout | undefined;
    clearTimeout(timer: ioBroker.Timeout | undefined): void;
}
