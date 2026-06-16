# Open Source Readiness

This project is being prepared for a formal open-source release. The checklist below separates completed engineering work from release blockers that still require maintainer decisions.

## Completed

- Package build output is generated into `packages/*/dist`.
- Published package exports point at compiled JavaScript and declaration files.
- Published package manifests declare public npm access for scoped packages.
- Package tarballs can be inspected with `npm run pack:check`.
- Local CI covers type checking, package builds, unit tests, and high-severity dependency audit findings.
- CLI usage and required argument validation are covered by unit tests without calling LLM providers.
- Type checking rejects ambiguous optional-property writes, unused locals/parameters, implicit returns, switch fallthrough, unchecked indexed access, and inconsistent import casing.
- Published package manifests declare the same Node.js runtime requirement as the root workspace.
- Engine unit coverage includes ordered streaming output across multiple active workflows.
- Engine construction trusts typed options and validates runtime invariants that TypeScript cannot express before executing turns.
- Engine construction validates cloneable state-schema parsed workflow default state.
- Engine construction rejects malformed runtime workflow state boundaries, including non-cloneable default state, schema-invalid default state, and reserved runtime state fields.
- Engine construction rejects duplicate workflow ids instead of silently overwriting workflow artifacts.
- Engine session creation and turn execution reject duplicate or unknown active workflow ids and mismatched cached workflow instances.
- Engine invalidation resets dependent fields with schema-valid default semantics, including deleting optional fields that are absent from the workflow default state.
- Engine invalidation preserves same-turn message-patched dependent fields when later workflow nodes write their source fields.
- Engine rejects raw or parsed workflow default states that define reserved `messages` and ignores state patch attempts to overwrite runtime message history.
- Engine validates workflow render responses and LLM render stream events before recording assistant messages.
- Engine validates raw prefetch node results before merging runtime prefetch values.
- Engine node execution separates prefetch cache/tool-message application from effect state/message/invalidation application.
- Engine internal helper code is grouped under `cli/`, `llm/`, `runtime/`, and `utils/` with kebab-case multiword filenames instead of accumulating unrelated helpers in `engine.ts`.
- CLI dynamic workflow and connector module loading is isolated from argument parsing and uses schema-backed export boundary checks.
- Default LLM client construction and request entry points use boundary schemas to reject malformed options, model overrides, message payloads, and structured schemas before provider calls.
- Default LLM provider model resolution and structured-output tool contract generation are isolated from request execution and response logging.
- Engine boundary schema helpers are centralized in `utils/` so CLI and LLM boundaries do not duplicate low-level Zod parsing helpers.
- Engine and workflow change tracking compare JSON-native values structurally, avoiding false dirty fields from object key ordering.
- Workflow routing metadata validates non-empty routing terms, known threshold names, and finite threshold values from `0` to `1`.
- Direct workflow definitions trust TypeScript shape and assert metadata, routing, state default, patch policy, invalidation, node, duplicate node name, and render policy invariants during definition.
- Manifest-backed workflow templates assert state default, patch policy, invalidation, node, duplicate node name, and render policy invariants before CLI metadata injection.
- Workflow DSL rejects duplicate patch declarations and patch schemas that target reserved runtime state fields.
- Program-style workflow DSL asserts workflow metadata when supplied, node metadata, invalidation config, and render policy invariants through Zod-backed definition guards.
- Workflow internal helper code is grouped under `definition/`, `runtime/`, and `utils/` with kebab-case multiword filenames while preserving root package exports.
- Workflow patch policies use definition schemas to reject malformed optional prompt metadata.
- Hook-style workflow DSL node option guards are isolated from hook registration and assert metadata, stage, and `when` invariants during definition.
- Workflow action helper configuration checks are isolated in Zod-backed definition guards before workflow execution.
- Workflow action render helpers reject invalid dynamic text output before returning render responses.
- Workflow runtime context storage is isolated from workflow artifact/type definitions while preserving the public `WorkflowContextStore` export.
- Workflow runtime message and `ToolMessage` construction logic is isolated from workflow artifact/type definitions while preserving public exports.
- Connector definition helper guards are isolated from registry execution and use boundary schemas to reject malformed contracts before construction.
- Connector registry public types avoid `any` while preserving schema-validated input and output inference.
- Prefetch helpers use schema-backed record/key checks for task collections and blank prefetch keys while preserving independent task failure isolation.
- Workflow runtime context accepts non-serializable values and treats runtime object replacements as changes.
- Engine and CLI diagnostics safely stringify non-serializable runtime values while distinguishing shared references from cycles.
- GitHub Actions runs the local CI gate on pushes and pull requests.
- Contribution, support, code of conduct, security, release, changelog, [root README](../README.md), and package README documents exist.
- Public package APIs are documented in `API.md`.
- Issue and pull request templates exist.
- Tooling config includes `.editorconfig` and npm `engine-strict` for consistent local setup.
- GitHub Actions uses read-only repository token permissions and does not persist checkout credentials.
- LLM-dependent smoke tests are separated from the default local gate.

## Blockers Before Public Release

- Choose an explicit open-source license and add `LICENSE`.
- Add the selected license to each published package manifest.
- Review package names and npm organization ownership before publishing `@pac/*`.
- Decide whether pre-1.0 releases should be published from `main` or a release branch.
- Review security contact configuration after the repository is public.
- Configure public maintainer contact for support and conduct reports after the repository is public.

## Recommended Next Work

- Add deterministic runtime checks for new scenario workflows as they are introduced.
- Add generated API docs if public API volume grows beyond the manually maintained `API.md`.
- Add release automation after the manual release process has been exercised once.
