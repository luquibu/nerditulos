# Nerditulos

Live captions and translation for events with simultaneous talks. One configured administrator manages rooms and sessions; attendees choose a room and an available language and read captions in their browser without an account.

## Project status

The application has not been implemented or deployed yet. This repository contains the initial PostgreSQL Compose service, environment template, shared development instructions, and provider evaluation.

Soniox is selected for the first integration after isolated tests with real English and Spanish audio. Those tests found unresolved transcription and translation errors. Browser latency, sustained operation with two rooms, authentication, and [core acceptance](docs/core-acceptance.md) remain unverified. See the [provider evaluation](docs/provider-evaluation.md) for measurements and limitations.

The planned core uses React and TypeScript, one Node service, PostgreSQL, Clerk for administrator identity, and Soniox for transcription and English-to-Spanish translation. It does not require a GPU, local models, or a generic provider framework.

## Available setup

Install Docker with Linux containers and Docker Compose. Copy [.env.example](.env.example) to `.env` in the repository root and set the PostgreSQL values. The Soniox and Clerk variables are for the upcoming application integration.

```sh
docker compose config --quiet
docker compose up -d --wait db
docker compose ps
```

The `db` service uses PostgreSQL 18 and a persistent volume mounted at `/var/lib/postgresql`. It does not publish a database port on the host. These commands start only PostgreSQL; there is no application start command yet. Preserve the volume during routine maintenance.

Installation instructions for the application and measured scaling limits will be added with the implementation. Two-room capacity has not been demonstrated in the application.

## Contributing

- [Contribution guide](CONTRIBUTING.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security reporting status and policy](SECURITY.md)
- [Development instructions](AGENTS.md)

## License

Project code is licensed under [MIT](LICENSE). Third-party material retains its own terms. The code of conduct is adapted from Contributor Covenant 3.0 under CC BY-SA 4.0, as attributed in that document. Conference recordings and private diagnostic evidence are not distributed with this repository.
