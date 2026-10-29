# Project plan: Nile HOL Reservations

Retrospective plan of what was built and when. Dates are approximate: each start is the first spec or build commit for the feature, and each end is the commit that marked it done in [scope/scope.md](scope/scope.md). Feature numbers match the scope doc.

Project span: 2026-10-02 to 2026-10-29 (about four weeks). All 25 features are done.

## Features

| # | Feature | Start | End |
|---|---|---|---|
| 1 | Stack & architecture | Oct 2 | Oct 6 |
| 2 | Coding standards & tooling | Oct 6 | Oct 6 |
| 3 | Data model | Oct 6 | Oct 6 |
| 4 | Authentik sign in & provisioning | Oct 7 | Oct 10 |
| 5 | Design system & UI foundation | Oct 10 | Oct 10 |
| 6 | Core booking loop | Oct 8 | Oct 10 |
| 7 | Admin: Testbed Types | Oct 8 | Oct 10 |
| 8 | Admin: API Keys | Oct 10 | Oct 10 |
| 9 | Admin: Testbeds | Oct 10 | Oct 11 |
| 10 | Admin: Users & user detail | Oct 10 | Oct 11 |
| 11 | Public landing page | Oct 11 | Oct 11 |
| 12 | Availability & booking rules | Oct 11 | Oct 12 |
| 13 | Manage reservations (sign in, cancel, reschedule) | Oct 12 | Oct 13 |
| 14 | Lab access & booking result screens | Oct 14 | Oct 16 |
| 15 | Email delivery & booking confirmations | Oct 14 | Oct 18 |
| 16 | Set password / welcome email | Oct 18 | Oct 18 |
| 17 | Reminder before start | Oct 20 | Oct 20 |
| 18 | Admin audit log | Oct 20 | Oct 20 |
| 19 | Testbed domain & predefined groups | Oct 23 | Oct 26 |
| 20 | Nile identity per domain | Oct 24 | Oct 25 |
| 21 | Testbed friendly name | Oct 23 | Oct 24 |
| 22 | Cleanup gap between labs | Oct 26 | Oct 26 |
| 23 | Cleanup hook for labs that end early | Oct 26 | Oct 27 |
| 24 | Nile Portal reset engine | Oct 27 | Oct 29 |
| 25 | Admin: Nile Portal Reset page | Oct 27 | Oct 27 |

## Phases

| Phase | Features | Start | End |
|---|---|---|---|
| Foundation | 1-5 | Oct 2 | Oct 10 |
| Slice 1: core booking loop | 6 | Oct 8 | Oct 10 |
| Slice 2: admin console | 7-10 | Oct 8 | Oct 11 |
| Slice 3: learner portal | 11-14 | Oct 11 | Oct 16 |
| Slice 4: email | 15-17 | Oct 14 | Oct 20 |
| Slice 5: audit log | 18 | Oct 20 | Oct 20 |
| Containerized deploy (outside the numbered features) | n/a | Oct 20 | Oct 20 |
| Slice 6: post-launch changes | 19-25 | Oct 23 | Oct 29 |

## Notes

- Features often ran in parallel. On Oct 10, features 5 to 10 were all moving.
- Features 2, 3, 5, 8, 11, 16, 17, 18, 22 and 25 show a single day because the spec, build and verify commits landed on one date.
- Some features were reopened after their end date:
  - 5: account menu added Oct 28.
  - 19: scope marked done Oct 26.
  - 24: review-fix PRs through Oct 29.
- Feature 7 has no spec of its own. It is dated from the Testbed Types work inside features 5 and 6.
