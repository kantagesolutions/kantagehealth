# AWS deployment runbook

The Kantage Health API is defined as an encrypted, private Fargate service behind an HTTPS Application Load Balancer. It is designed for a dedicated healthcare account inside the Kantage AWS Organization.

## Before any apply

1. Confirm the AWS Organizations Business Associate Addendum is active. It was accepted for the Kantage organization on September 22, 2026.
2. Create a dedicated `Kantage Healthcare` member account in AWS Organizations and use its account ID as `expected_account_id`.
3. Decide the retention period for immutable audit exports. The current proposed value is seven years. S3 Object Lock in compliance mode cannot be shortened after deployment.
4. Issue and validate an ACM certificate for the API hostname, such as `api.kantagehealth.com`. The DNS validation record can be placed in Cloudflare before enabling the API service.
5. Build and push an immutable ARM64 API image to the ECR repository output by Terraform. This repository intentionally rejects mutable tags.
6. Create the tenant registry secret and the separate least-privilege database credentials referenced from that registry. Do not give the service the RDS master secret.

## What Terraform creates

- KMS key, encrypted document bucket, immutable audit bucket, and CloudTrail
- Private PostgreSQL with enforced TLS, backups, deletion protection, and encrypted storage
- Cognito staff user pool with MFA
- VPC with isolated private application and database subnets plus public load-balancer subnets
- ECR repository, CloudWatch logs, ECS Fargate cluster, and staff identity service
- When the API stage is enabled: NAT gateway, two API tasks, and an HTTPS-only Application Load Balancer with an HTTP-to-HTTPS redirect

## Apply sequence

Copy `infrastructure/terraform.tfvars.example` to a local `terraform.tfvars`; it is intentionally ignored by Git. Populate actual values only in the dedicated account.

Run `infrastructure/bootstrap-state-backend.sh` first in the dedicated account. It creates the encrypted, versioned, private S3 backend that holds Terraform state. Then initialize Terraform with the bucket, `production/healthcare.tfstate` key, and `us-east-1` region printed by the script.

Stage 1 keeps `enable_api_service = false`. It creates the encrypted database, storage, immutable audit trail, VPC, ECR repository, logging, and identity foundation without incurring Application Load Balancer or NAT Gateway charges and without exposing an API.

For Stage 2, set `enable_api_service = true` only after the ACM certificate, immutable ECR image URI, and tenant registry secret ARN are real. Run `terraform plan` before each stage, review the AWS cost and resource list, and only then run `terraform apply`.

After the ECS service is healthy, point the API hostname to the load balancer in Cloudflare. Only after the live HTTPS booking route is verified should Express Dental’s public button be switched from the call-only fallback to Kantage Health.

## Automatic production deployment

The workflow at `.github/workflows/deploy-production.yml` deploys every successful push to `main`. It can also be started manually from GitHub Actions.

The workflow first builds the API and portal, applies the migrations to an isolated PostgreSQL test database, and runs the test suite. It then uses GitHub OIDC to obtain short lived AWS credentials. No permanent AWS access key is stored in GitHub.

The deployment publishes immutable ARM64 images, runs the production migration as a one time Fargate task, deploys the API, deploys the portals, waits for both ECS services to stabilize, and verifies the four public health endpoints. ECS deployment circuit breakers restore the previous working task revision if a rollout fails.

Before enabling the workflow, apply the Terraform changes once so AWS has the GitHub OIDC role and migration task definition. The trusted identity is limited to the `kantagesolutions/kantagehealth` repository and its `production` GitHub environment. If this AWS account already has the GitHub OIDC provider, set `github_oidc_provider_arn` to that provider ARN before applying Terraform.

The GitHub `production` environment may be configured without required reviewers for fully automatic deployment. Environment secrets are not required. Repository pushes still require the normal branch permissions.
