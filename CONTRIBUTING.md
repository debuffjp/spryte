# Contributing to spryte

spryte is developed inside the [debuff monorepo](https://github.com/debuffjp/debuff) at `packages/spryte`, which is the canonical source, and mirrored to [debuffjp/spryte](https://github.com/debuffjp/spryte) with `git subtree split`. Open issues on either repo. Send code changes to debuff, so the games there keep testing every change.

```bash
npm install
npm test          # unit tests (happy-dom, fake WebGL2)
npm run build     # dist/ with types
npm run example   # the minimal example in a browser
```

Rules:

- No runtime dependencies.
- No allocation in the per-sprite hot path (`Draw.sprite`, `WebGL2Backend.quad`).
- Performance claims cite a reproducible benchmark run, with the hardware and browser stated.
- A WebGL2 behaviour change comes with a test in `test/webgl2.test.ts`.
