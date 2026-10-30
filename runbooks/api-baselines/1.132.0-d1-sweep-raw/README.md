# Installed API compatibility baseline

The VM 100 API image `agent-swarm-api:1.132.0-d1-sweep-raw` was built from
`3bcbfb35275127a505251792f363f8a975411fcd` plus two source changes absent from
that clean checkout: Anthropic execution in `raw-llm.ts`, and HTTP task creation
accepting and forwarding `followUpConfig`. Replacing its binary from the clean
checkout would silently remove both behaviors.

The public embedded JavaScript was recovered from the installed executable.
`raw-llm.embedded.js.txt` and `task-follow-up.embedded.diff` retain the relevant
evidence. The typed restoration in this repository preserves these behaviors;
the dependency-injected tests make no provider requests.

Before adding managed API changes, the restored baseline was compiled using the
installed image's Bun 1.3.11, `/build` source path, and original compile flags.
Its entire 23,057,277-byte application bundle exactly matched the installed
bundle. `reconstruction-proof.json` records the image, binary, patch and bundle
hashes. The executable hashes differ; the application JavaScript is
byte-identical.

To repeat the code comparison against two public executable artifacts:

```sh
bun scripts/verify-installed-api-bundle.ts LIVE_API REBUILT_BASELINE_API
```

The managed API patch is applied only after this baseline comparison and changes
`src/be/db.ts`, `src/http/poll.ts`, `src/http/tasks.ts`, and
`src/tasks/worker-follow-up.ts`. Derivative runtime images retain the installed
API's other runtime files and entrypoint. This evidence does not establish that
the deployed API has been replaced or that live account enrollment has passed.
