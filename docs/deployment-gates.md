# Healthcare deployment gates

The Terraform configuration intentionally refuses to create resources until the target AWS account is specified and `baa_attested` is set to true. The BAA is an agreement that must be accepted by an authorized Kantage representative in AWS Artifact for the dedicated healthcare account. It cannot be accepted by deployment automation.

Provision a separate AWS account inside the `Healthcare` organizational unit. AWS requires a unique account email; keep that account separate from the Kantage management account. Put the exact account ID in the environment file before plan or apply.

The audit bucket uses S3 Object Lock in compliance mode. Its retention setting is legally significant and cannot be shortened, so `audit_retention_years` has no default. Confirm the retention requirement before an apply.

The database is deliberately private, encrypted with a customer-managed KMS key, has point-in-time backups, and has deletion protection. The RDS master secret is for migrations only. Runtime service credentials must be a separate least-privilege login placed in Secrets Manager; the platform resolves it by tenant registry instead of putting it in source code or task environment variables.
