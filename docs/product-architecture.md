# Kantage Healthcare product architecture

Kantage Healthcare uses one application codebase with a control plane for Kantage and an isolated workspace for every customer organization and clinic. The existing request path uses a dedicated PostgreSQL connection pool for each organization, with PostgreSQL row-level security applied again within that organization. This is intentionally stricter than UI-only tenant filters.

## Personas and surfaces

| Surface | Purpose | Patient data |
|---|---|---|
| Kantage owner console | Onboard organizations, monitor subscriptions, clinics, onboarding, and support | No routine access |
| Clinic workspace | Practice profile, team, schedules, patient operations, documents, and payments | Limited by location and capability |
| Break-glass support session | Exceptional troubleshooting | Explicit reason, approval, expiry, and audit trail |

## Capability model

Roles are groups of database-backed capabilities. The application checks capabilities such as `patients.edit` and `payments.manage`, rather than trusting a job title presented by the browser. A location assignment further limits a staff member to explicitly assigned clinics.

## Onboarding

1. Create organization
2. Add one or more locations
3. Add providers and office hours
4. Configure appointment types and operatories
5. Invite the team
6. Connect payments
7. Add brand assets and documents
8. Import patients
9. Review and go live

## Payments and documents

Payment plans carry provider references rather than payment-card data. The payment processor owns sensitive payment credentials. Documents are represented in PostgreSQL but stored through a secure object-storage adapter; signed, time-limited access is generated only after authorization.

## Production gates

The service architecture supports healthcare safeguards but does not itself establish HIPAA compliance. Before production patient data: execute a BAA, complete risk analysis, configure backups and disaster recovery, establish incident response and retention policies, train staff, and validate each AWS control in the deployed account.
