# ioBroker.smart-text2command

An ioBroker adapter for local natural-language device control. Development follows the [technical specification](documentation/ioBroker.smart-text2command_SPECIFICATION.md).

## Current state

Phase 0 and the discovery and approval foundation of Phase 1 are implemented. The adapter discovers ioBroker objects and room/function enums, maps conservative device capabilities, and stores a registry in the instance data directory. Every new device is disabled and every action requires a separate approval tied to the current capability fingerprint. A changed target, type, range, or mapping invalidates the affected approval. Critical and unknown roles are not executable.

The NLP engine, command execution, `sendTo` API, and React/MUI administration are later phases. No device commands are issued by the current adapter. The current Admin page is an informational placeholder; approval methods exist internally but have no UI yet.

## Development

Requires Node.js 22 or later.

```sh
npm ci
npm run check
npm run lint
npm run format:check
npm test
npm run test:integration
```

TypeScript tests live under `test/`. The persistent registry is `devices-v1.json` in the ioBroker instance data directory. If its checksum or schema is invalid, discovery does not start and no approval is used.

See [implementation status](documentation/IMPLEMENTATION_STATUS.md) for scope, validation and open work.

## License

MIT. See [LICENSE](LICENSE).
