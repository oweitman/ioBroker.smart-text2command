# Implementation status

## Phase 0 and Phase 1 plan

| Area | Files | Verification |
| --- | --- | --- |
| Types and request validation | `src/types/api.ts`, `src/api/RequestValidator.ts` | `test/RequestValidator.test.ts` |
| Discovery and capability mapping | `src/devices/DeviceDiscovery.ts`, `src/devices/CapabilityMapper.ts` | `test/DeviceRegistry.test.ts` |
| Approval policy and durable updates | `src/devices/DeviceRegistry.ts`, `src/devices/DeviceCatalog.ts`, `src/storage/DeviceRepository.ts` | `test/DeviceRegistry.test.ts`, `test/DeviceRepository.test.ts` |
| Adapter lifecycle | `src/main.ts`, `io-package.json` | package and adapter integration tests |

The existing adapter template supplies TypeScript, package tests, and CI. No NLP or additional runtime dependency is needed for these phases. Development dependencies add `@types/mocha`, ESLint, Prettier, and the official `@iobroker/eslint-config`.

## Decisions and limits

- The adapter name is `smart-text2command`. The old document name `nlp-control` was a working name.
- Approval is per action and state ID, with a fingerprint of state target, data type, read/write flags, range, unit, enum values, and mapping. Approval is permanent until revoked or invalidated by a material change.
- The current implementation maps only conservative Boolean switches, bounded dimmers, read-only measured temperatures, and bounded explicit setpoints. Position and ambiguous alias targets wait for a later mapping design.
- Device IDs use the nearest parent device object, then channel object, then state ID. If parent structure changes, a device appears as new and requires approval again.
- Object changes update an in-memory snapshot and trigger a debounced reconciliation. Initial startup reads the object database once. The 100,000-object limit stops discovery instead of silently truncating it.
- Registry writes are serialized and replace a temporary file. A failed write leaves the previous in-memory registry active. Corrupt persisted data stops discovery, keeping execution unavailable.
- The admin approval UI and `sendTo` execution path belong to later phases. There is currently no device command path and no OS-level `exec`.

## Validation

- `npm run check`: passed.
- `npm run lint`: passed.
- `npm run format:check`: passed.
- `npm test`: unit and package tests passed.
- `npm run test:integration`: adapter startup passed against the ioBroker test controller.

The actual discovery event path against a populated controller and the Admin approval workflow remain to be verified in the next phase. The current integration test verifies startup only.
