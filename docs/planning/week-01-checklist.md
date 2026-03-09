# Week 01 Checklist (Issue Template)

Use this as a copy-paste issue body for Week 1 execution.

## Week Goal
Stabilize local development for `apps/api` so setup works from a clean clone.

## Time Budget
- Total: 6 to 8 hours
- Session 1 (2h): environment + dependencies
- Session 2 (2h): D1 setup + migration run
- Session 3 (2h): endpoint smoke tests + docs cleanup
- Buffer (0 to 2h): fix blockers

## Checklist
- [ ] Clone/fresh pull and enter `apps/api`
- [ ] Install dependencies successfully
- [ ] Create `.dev.vars` from `.dev.vars.example`
- [ ] Set a secure `API_KEY_PEPPER`
- [ ] Create D1 DB (`todoless`) and update `database_id` in `wrangler.toml`
- [ ] Run local migrations successfully
- [ ] Start worker locally
- [ ] Verify `GET /v1/health`
- [ ] Verify `POST /v1/auth/register` returns user/workspace plus pending verification details
- [ ] Verify `POST /v1/auth/verify-email` returns the first personal API key
- [ ] Update docs if setup commands changed
- [ ] Commit changes with clear message

## Commands
```bash
cd apps/api
npm install
cp .dev.vars.example .dev.vars
# edit .dev.vars and set API_KEY_PEPPER to a long random string
npx wrangler d1 create todoless
# paste returned database_id into apps/api/wrangler.toml
npm run db:migrate:local
npm run dev
```

Health check:
```bash
curl -s http://127.0.0.1:8787/v1/health
```

Register smoke test:
```bash
curl -s -X POST http://127.0.0.1:8787/v1/auth/register \
  -H "content-type: application/json" \
  -d '{"email":"founder@example.com","workspace_name":"Acme Ops"}'
```

Verify-email smoke test:
```bash
curl -s -X POST http://127.0.0.1:8787/v1/auth/verify-email \
  -H "content-type: application/json" \
  -d '{"verification_token":"<verification_token_from_register>"}'
```

## Definition of Done
- New machine/fresh clone setup takes <= 20 minutes.
- Health, register, and verify-email endpoints all work locally.
- No manual undocumented setup steps remain.
- `README.md` and `apps/api/README.md` are accurate.

## Blockers and Fallback
- If `npm install` fails due network/proxy:
  - [ ] capture error output
  - [ ] retry with known-good network
  - [ ] document workaround in `apps/api/README.md`
- If D1 migration fails:
  - [ ] run migration command again with verbose output
  - [ ] verify `database_id` and migration filename ordering

## End-of-Week Log
- What shipped:
- What failed:
- Setup time from clean clone:
- Top risk for Week 2:
- Scope cut made (if any):
