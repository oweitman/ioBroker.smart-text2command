# ioBroker.smart-text2command

An ioBroker adapter for local natural-language device control. Development follows the [technical specification](documentation/ioBroker.smart-text2command_SPECIFICATION.md).

## Current state

Phases 0–3 are implemented. The adapter discovers ioBroker objects and room/function enums, maps conservative device capabilities, and stores a registry in the instance data directory. Every new device is disabled and every action requires a separate approval tied to the current capability fingerprint. A changed target, type, range, or mapping invalidates the affected approval. Critical and unknown roles are not executable.

NLP.js classifies German and English requests using a versioned local model. Baseline training runs in a worker thread when no valid model exists. A new model is activated only after fixed regression cases pass. Device names and aliases are resolved from the current registry without retraining. User intents have separate persistent storage with typed action validation.

The `sendTo` API accepts `processText` with `mode: "analyze"` or `mode: "execute"`. Execution requires a current per-action approval and rechecks the target object immediately before access. `input.text` only analyzes; it cannot execute. Results appear in `output.response`, `output.result`, and `output.status`. Admin-only message commands manage devices, typed user intents, model training, rollback, and diagnostics. Admin mutation requires an authenticated admin sender and an administrator group member. The React/MUI administration page is Phase 4; the current Admin page only configures the default language.

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

TypeScript tests live under `test/`. The instance data directory contains `devices-v1.json`, `training/user-intents-v1.json`, `audit-v1.json`, and versioned files under `models/`. Corrupt registry or intent data stops the respective initialization. A damaged active NLP model falls back to the previous validated version when available.

See [implementation status](documentation/IMPLEMENTATION_STATUS.md) for scope, validation and open work.

## License

MIT. See [LICENSE](LICENSE).
