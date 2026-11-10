export type AdminTransport = (command: string, message: Record<string, unknown>) => Promise<unknown>;

export class AdminApi {
    public constructor(private readonly transport: AdminTransport) {}

    public async call<T>(command: string, message: Record<string, unknown> = {}): Promise<T> {
        const result = await this.transport(command, message);
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new Error('Invalid adapter response');
        }
        if ('error' in result && typeof result.error === 'string') {
            throw new Error(result.error);
        }
        return result as T;
    }
}
