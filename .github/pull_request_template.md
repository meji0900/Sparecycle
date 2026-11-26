## What changed

<!-- One or two sentences. -->

## Checklist

- [ ] Docs updated the same day: `src/app/(site)/docs/`, `docs/` or `src/lib/changelog.ts` (the CI docs check fails when `src/app/api/`, `src/server/` or `node-client/src/` change without one of these). If nothing a user or node operator does changes, add the label `no-docs`.
- [ ] A shipped feature moved from `src/lib/roadmap.ts` to `src/lib/changelog.ts`, with its date and evidence (a transaction, a document or a live endpoint).
- [ ] New or changed `/api/v1` endpoints are described in the OpenAPI modules (`src/lib/openapi*.ts`).
- [ ] `npm run typecheck`, `npm run lint` and `npm test` pass.
