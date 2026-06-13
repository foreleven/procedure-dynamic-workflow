# Releasing

This project is pre-1.0 and is not ready for public release until maintainers add an explicit `LICENSE` file.

## Versioning Policy

- Packages follow semver once public releases begin.
- Before `1.0.0`, minor versions may include breaking API changes.
- Patch versions should be limited to bug fixes, documentation fixes, and packaging fixes.
- Keep `@pac/engine` and `@pac/workflow` versions aligned while their APIs evolve together.

## Release Checklist

1. Confirm a `LICENSE` file exists and package metadata names the selected license.
2. Run the publish-readiness guard:

   ```bash
   npm run publish:check
   ```

   This command intentionally fails until the repository `LICENSE` exists and every published package declares the selected license.
3. Update package versions in:
   - `packages/workflow/package.json`
   - `packages/engine/package.json`
   - dependent workspace references when needed.
4. Update `CHANGELOG.md` with user-visible changes.
5. Run the full local gate:

   ```bash
   npm ci
   npm run ci
   ```

6. Verify tarball contents from a clean tree:

   ```bash
   npm run clean
   npm run smoke:tarballs
   ```

7. Inspect package metadata:

   ```bash
   npm pack --workspace @pac/workflow --dry-run
   npm pack --workspace @pac/engine --dry-run
   ```

8. Publish in dependency order:

   ```bash
   npm publish --workspace @pac/workflow --access public
   npm publish --workspace @pac/engine --access public
   ```

9. Create and push a git tag for the release.

## Manual LLM Smoke Test

Run this only when release changes touch LLM integration or structured tool-call behavior:

```bash
npm run test:llm
```

This command may call a real model provider and is intentionally separate from the default release gate.
