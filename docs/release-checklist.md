# Release checklist

## Before public GitHub launch

- [ ] Choose the final GitHub repository owner/name.
- [ ] Confirm `contextgym` naming on GitHub/npm immediately before release.
- [ ] Add repository/homepage/bugs fields to `package.json` after the GitHub URL exists.
- [ ] Run CI on Windows and Linux with Node 20/22/24.
- [ ] Run `npm pack --dry-run` and inspect the package file list.
- [ ] Test a clean global install from the generated `.tgz`.
- [ ] Test `contextgym doctor` on Windows.
- [ ] Test `contextgym optimize --dry-run` on a clean demo repository.
- [ ] Test one real 3-pair A/B run.
- [ ] Test `report --open`.
- [ ] Test `apply --dry-run`, `apply --yes`, and stale-HEAD refusal.
- [ ] Verify no user paths, credentials, raw prompts, or private source files are committed.
- [ ] Replace any private benchmark paths in screenshots/GIF with a public demo repository.

## npm release

```bash
npm login
npm pack
npm publish
```

After publishing, verify from a clean directory:

```bash
npx contextgym@latest --version
npx contextgym@latest doctor
```

## Launch assets

- [ ] README hero benchmark.
- [ ] 20–30 second terminal/demo GIF.
- [ ] HTML report screenshot.
- [ ] Architecture diagram.
- [ ] One public reproducible demo repository.
- [ ] GitHub Topics: `ai`, `coding-agents`, `codex`, `agents-md`, `context-engineering`, `developer-tools`.
