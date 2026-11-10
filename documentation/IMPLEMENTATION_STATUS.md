# Implementation status

## Phase 3

The command pipeline now supports the six MVP actions through `processText`, including analysis, execution, clarification, idempotency, approval and live-object rechecks, bounded audit metadata, and structured results. The adapter messagebox exposes device management, typed user intents, background training, rollback and diagnostics. Management commands require an authenticated Admin sender and an administrator-group user. `input.text` provides analysis only; its global output is serialized through `output.*` states. No OS-level `exec` is used.

The React/MUI Admin interface and manual device approval workflow are Phase 4. Until then, approvals are available only through the protected message API. Device I/O waits at most 15 seconds; after a write timeout, the target adapter may still apply the write later, so the result is an error with uncertain target state. Runtime testing against a populated controller and execution through a real device adapter remain open.

## Phase 2

The NLP.js provider uses the stable modular `@nlpjs/nlp` 4.27.0 API with the German and English language packages. German and English baseline corpora are versioned in `resources/training/`; custom intents are stored separately. Training and regression run in `src/nlp/training-worker.js`, outside the adapter event loop. `ModelRepository` writes checksummed model versions and an active manifest, supports rollback, and falls back to the previous model if the active file is damaged. The adapter loads the last valid model or starts baseline training and reports `info.modelStatus`.

`EntityParser` recognizes localized numbers, percentages, temperatures, room names, quoted device phrases, negations, and unsupported group, exception, time, and multiple-action syntax. `DeviceResolver` matches current approved device names and aliases and asks for clarification on tied candidates. Tests remain under `/test`.

The Phase 3 pipeline rejects unsupported syntax and negation, rechecks approvals before each state access, and exposes device execution only through `sendTo`.

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
- The admin approval UI belongs to Phase 4. Device execution uses only the approved `sendTo` path; there is no OS-level `exec`.

## Validation

- `npm run check`: passed.
- `npm run lint`: passed.
- `npm run format:check`: passed.
- `npm test`: 20 TypeScript tests and 61 package tests passed.
- `npm run test:integration`: two tests passed against the ioBroker test controller, including `info.modelStatus = ready` after baseline training and the `input.text` analysis path.
- `npm audit --omit=dev`: zero runtime dependency findings after using modular NLP.js packages.

The actual discovery event path against a populated controller remains to be verified. The Admin approval workflow belongs to Phase 4. The release acceptance target of at least 20 validated positive examples per language and core intent remains open for Phase 5.
