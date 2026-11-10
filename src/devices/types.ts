export type CapabilityKind = 'onOff' | 'brightness' | 'temperatureSetpoint' | 'readTemperature' | 'position';
export type ActionKind = 'turnOn' | 'turnOff' | 'setLevel' | 'setTemperature' | 'getState' | 'getValue';
export type ValueKind = 'boolean' | 'number' | 'string';

export interface Capability {
    kind: CapabilityKind;
    stateId: string;
    readStateId?: string;
    readable: boolean;
    writable: boolean;
    valueKind: ValueKind;
    min?: number;
    max?: number;
    unit?: string;
    enumValues?: Array<string | number>;
    mapping?: {
        on?: boolean | number | string;
        off?: boolean | number | string;
        scale?: number;
        offset?: number;
    };
    fingerprint: string;
    needsReview: boolean;
}

export interface DeviceRecord {
    id: string;
    sourceObjectId: string;
    displayName: string;
    roomIds: string[];
    functionIds: string[];
    enumNames?: Record<string, string | Record<string, string>>;
    aliases: Partial<Record<'de' | 'en', string[]>>;
    discoveredCapabilities: Capability[];
    approvedCapabilities: Record<string, string>; // action:state ID -> approved fingerprint
    enabled: boolean;
    lastSeenAt: string;
    status: 'available' | 'missing' | 'needsReview';
}

export interface ObjectSnapshot {
    id: string;
    type: 'device' | 'channel' | 'state' | 'enum';
    common: {
        name?: string | Record<string, string>;
        role?: string;
        type?: string;
        read?: boolean;
        write?: boolean;
        min?: number;
        max?: number;
        unit?: string;
        states?: Record<string, string> | string;
        members?: string[];
        alias?: {
            id?:
                | string
                | {
                      read?: string;
                      write?: string;
                  };
        };
    };
}

export interface DeviceStore {
    schemaVersion: 1;
    devices: DeviceRecord[];
}
