# Product fork patches

Base: upstream tag `dsh-v0.2.2-rc.1` (`66491b05`). The installed app's build commit `c59d10a` is not public; every package README in the app matches this tag byte for byte (master `fcc0ad4` differs in 65).

Own code lives in top-level `ours/*` as profile bundles, outside `packages/`: the upstream build and gates glob `packages/*/*/package.json` (root `tsdown.config.ts`, `scripts/*`), so a package under `packages/ours/` breaks `pnpm run build`. `ours/` is not a pnpm workspace member and is installed into a profile with `dsh plugin --profile <name> add link:<dir>`.

Changes to upstream files:

| File | Change | Why |
| --- | --- | --- |
| `.gitignore` | `.dsh-dev/`, `.tools/`, `secrets/`, `*.key` | local dev home, local toolchain, secrets |
