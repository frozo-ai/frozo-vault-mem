---
id: mem_2026-04-27_000001
type: decision
title: "Use Supabase for KinCare auth"
agent: human
session: null
created: "2026-04-27T14:32:00.000Z"
updated: "2026-04-27T14:32:00.000Z"
confidence: 0.85
sources:
  - "[[meeting-2026-04-25]]"
  - "[[code-review-pr-142]]"
contradicts: []
supersedes: []
tags: [kincare, auth, architecture]
project: kincare
ttl_days: null
status: active
human_reviewed: true
human_approved: true
schema_version: "0.1"
---

# Use Supabase for KinCare auth

## Rationale

Supabase gives us first-party Postgres, RLS policies, and DPDP-compatible
EU/India hosting. Family-member multi-tenancy maps cleanly onto auth schemas.

## Considered alternatives

- **Clerk** — rejected: harder DPDP story, no first-party DB.
- **Auth0** — rejected: pricing on family-tier multi-tenancy doesn't scale.

## Constraints

- DPDP compliance required
- Family-member multi-tenancy
