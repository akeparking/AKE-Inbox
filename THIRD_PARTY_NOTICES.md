# Third-party notices and provenance

AKE's original source is MIT licensed; see [LICENSE](LICENSE). Package dependencies and separately deployed services retain their own licenses. This repository does not distribute upstream service images, complete Chatwoot source, WhatsApp sessions, proprietary CRM code, private knowledge collections or commercially licensed fonts.

| Project | Relationship | Upstream license / source |
|---|---|---|
| AKE Revenue Intelligence | Same-maintainer predecessor; inquiry/CRM/event architecture | [Repository](https://github.com/akeparking/ake-revenue-intelligence); AKE copyright retained |
| Chatwoot | Runtime API, Rails extension hooks, inbox/seat UI and Docker deployment | [License](https://github.com/chatwoot/chatwoot/blob/develop/LICENSE): community code under MIT, enterprise directory under separate terms; third-party portions retain their terms |
| WAHA | Separate WhatsApp service, Chatwoot App integration and constrained delivery wrapper | [Core Apache-2.0 license](https://github.com/devlikeapro/waha/blob/core/LICENSE); Plus/commercial distributions have separate conditions |
| whatsapp-web.js | Upstream engine used by WAHA WEBJS; not separately embedded here | [Apache-2.0](https://github.com/wwebjs/whatsapp-web.js/blob/main/LICENSE); [WAHA engine documentation](https://waha.devlike.pro/docs/engines/webjs/) |
| Evolution API | Earlier separately deployed WhatsApp bridge retained for migration | [Upstream](https://github.com/EvolutionAPI/evolution-api); check the license at the deployed image's exact version |
| Next.js / React | Web application | [Next.js](https://github.com/vercel/next.js), [React](https://github.com/facebook/react) |
| NestJS / Zod | API and validation | [NestJS](https://github.com/nestjs/nest), [Zod](https://github.com/colinhacks/zod) |
| PostgreSQL / Redis / BullMQ | Persistence, cache and queues | [PostgreSQL](https://www.postgresql.org/about/licence/), [Redis](https://github.com/redis/redis), [BullMQ](https://github.com/taskforcesh/bullmq); verify the chosen versions' terms |
| PDFKit / Noto Sans SC / Phosphor Icons | Document export, fonts and UI icons | Dependency manifests and their installed LICENSE files govern redistribution |
| Gitleaks | Development/CI secret detection, downloaded with checksum verification | [MIT](https://github.com/gitleaks/gitleaks/blob/master/LICENSE) |

Optional knowledge tooling and model runtimes are configured separately, not bundled. No license to private AKE knowledge documents is granted by publishing adapters. Logos and vendor names identify the relevant products; no endorsement or trademark ownership is implied. Inspect actual image/package versions before distributing an assembled deployment.

Source provenance: a 2026-10-23 snapshot of the predecessor worktree, including uncommitted changes, plus eight supplemental Google acceptance files. The upstream Chatwoot image pinned by the local marketing overlay is recorded in its Compose file. The public repository begins with a newly reviewed root commit; private historical Git objects were not copied. All business modules, migrations and test directories from the source snapshot remain included. The supplementary scripts were parameterized, historical account/case details removed, and timers converted to inert examples.
