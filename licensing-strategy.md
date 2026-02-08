# Todoless Licensing Strategy (Open Source + SaaS Revenue)

This is a product strategy memo, not legal advice.

## Goal
Be truly open source while preserving a strong SaaS business.

## Recommended model
- Core engine/API: **Apache-2.0** (OSI-approved, enterprise-friendly adoption).
- Hosted cloud/control-plane features: **proprietary SaaS terms**.
- Brand assets and trademark: reserved.

## Why Apache-2.0 for core
- High trust and low friction for developer adoption.
- Includes explicit patent license, which many enterprises require.
- Maximizes ecosystem contributions and SDK integrations.

Reference:
- Apache 2.0 summary and terms: https://choosealicense.com/licenses/apache-2.0/
- OSI approval list: https://opensource.org/licenses

## How we still make money
Revenue is not from hiding CRUD source. Revenue is from hosted reliability and enterprise capabilities.

Paid cloud features:
- Managed webhook retries + DLQ + replay UI
- Metering, usage analytics, and billing integration
- Multi-workspace organization controls
- SSO/SAML/SCIM
- Audit exports and retention controls
- SLA and premium support

## Packaging split
Open source repo (`todoless-core`):
- Identity/workspaces/RBAC
- Task APIs
- Basic webhook support
- Local self-host docs

Cloud repo/service (`todoless-cloud`):
- Billing + entitlements
- Managed eventing reliability controls
- Enterprise auth and admin features
- Hosted observability and ops tooling

## Optional stronger-protection variant
If copy-risk becomes a problem later:
- Keep Apache-2.0 core stable,
- Put advanced cloud-only modules in separate proprietary services,
- Reserve trademarks and names to protect market confusion.

This avoids introducing non-OSI licenses that may hurt adoption.

## Immediate action list
1. Publish a top-level `LICENSE` file with Apache-2.0.
2. Add a `TRADEMARKS.md` to reserve brand/logo usage.
3. Add `CLOUD_TERMS.md` for paid hosted product terms.
4. Keep premium features out of the open core repo from day one.
