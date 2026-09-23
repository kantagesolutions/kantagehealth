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

Stage 1 keeps `enable_api_service = false`. It creates the encrypted database, storage, immutable audit trail, VPC, ECR repository, logging, and identity foundation without incurring Application Load Balancer or NAT Gateway charges and without exposing an API.

For Stage 2, set `enable_api_service = true` only after the ACM certificate, immutable ECR image URI, and tenant registry secret ARN are real. Run `terraform plan` before each stage, review the AWS cost and resource list, and only then run `terraform apply`.

After the ECS service is healthy, point the API hostname to the load balancer in Cloudflare. Only after the live HTTPS booking route is verified should Express Dental’s public button be switched from the call-only fallback to Kantage Health.
