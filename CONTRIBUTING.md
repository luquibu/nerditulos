# Contributing

Nerditulos is being prepared for its first application implementation. The repository currently contains configuration and documentation; it has no application build or test commands yet.

## Propose a change

Search existing [issues](https://github.com/luquibu/nerditulos/issues) before opening one. For a bug, describe the expected result, actual result, environment, and steps to reproduce it. For a feature, explain the user problem and the smallest useful change. Discuss changes to scope or provider contracts before implementing them.

Keep issue reports, pull requests, documentation, and configuration comments in English. Follow the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through the process in [SECURITY.md](SECURITY.md), not a public issue.

## Work on the repository

Read [AGENTS.md](AGENTS.md) for product constraints and verification expectations. Create a branch from the current default branch and keep the change focused. Use a fork if you do not have write access.

[README.md](README.md) describes the available setup. Copy `.env.example` to `.env` only when you need local services and provide your own credentials. Do not include credentials, private installation details, diagnostic archives, or conference recordings in a contribution. Audio and other third-party assets require documented provenance and redistribution rights.

## Verify your change

- Review the diff and run `git diff --check HEAD` to check staged and unstaged changes. Review untracked files separately; the command includes new files only after they are added to the index.
- For documentation, check links, examples, and consistency with the current implementation and stated limitations.
- For Compose changes, run `docker compose config --quiet` with local environment values. Do not paste expanded configuration containing secrets into a report.
- When application commands exist, run the relevant checks defined by the repository. Do not claim tests that are not available or were not run.
- Use deterministic cases for ordering, duplicates, and room/session isolation. Recognition quality and latency require real audio. Record output type (original or translated), language, partial/final state, and start/end measurement points; distinguish provider timing, Node receipt or publication, and browser display. Use [core acceptance](docs/core-acceptance.md) for core behavior.

Do not remove PostgreSQL volumes during routine verification. Running live inference or changing deployed services is separate from reviewing documentation.

## Open a pull request

Explain the problem, the resulting behavior, and the checks performed. Include limitations and any linked issue. For user interface changes, include a screenshot without private data. Keep failed attempts visible when they affect the conclusion.

Your contribution must be compatible with the project's [MIT license](LICENSE). Preserve applicable notices and licenses for third-party material, including the separate attribution in the code of conduct.
