terraform {
  required_version = ">= 1.8.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.62"
    }
  }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" { state = "available" }

variable "region" { type = string, default = "us-east-1" }
variable "environment" { type = string, default = "production" }
variable "expected_account_id" { type = string }
variable "baa_attested" {
  type        = bool
  default     = false
  description = "Set only after an authorized Kantage representative accepts the AWS BAA for this healthcare account."
}
variable "audit_retention_years" {
  type        = number
  description = "Legal retention period for immutable audit exports. Object Lock retention cannot be shortened."
  validation { condition = var.audit_retention_years >= 1 && var.audit_retention_years <= 100, error_message = "Set a retention period from 1 to 100 years." }
}

locals {
  name = "kantage-healthcare-${var.environment}"
  tags = { Application = "Kantage Healthcare", Environment = var.environment, ManagedBy = "Terraform", DataClass = "PHI" }
}

resource "terraform_data" "compliance_gate" {
  input = local.name
  lifecycle {
    precondition { condition = data.aws_caller_identity.current.account_id == var.expected_account_id, error_message = "Refusing to create healthcare resources in an unexpected AWS account." }
    precondition { condition = var.baa_attested, error_message = "Refusing to create PHI-capable resources until the AWS BAA is accepted and attested." }
  }
}

resource "aws_kms_key" "data" {
  description             = "Kantage Healthcare PHI encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = local.tags
}
resource "aws_kms_alias" "data" { name = "alias/${local.name}-phi" target_key_id = aws_kms_key.data.key_id }

resource "aws_s3_bucket" "documents" {
  bucket_prefix       = "${local.name}-documents-"
  force_destroy       = false
  tags                = local.tags
  depends_on          = [terraform_data.compliance_gate]
}
resource "aws_s3_bucket_public_access_block" "documents" {
  bucket = aws_s3_bucket.documents.id
  block_public_acls = true
  block_public_policy = true
  ignore_public_acls = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "documents" { bucket = aws_s3_bucket.documents.id versioning_configuration { status = "Enabled" } }
resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "aws:kms" kms_master_key_id = aws_kms_key.data.arn } bucket_key_enabled = true }
}

resource "aws_s3_bucket" "audit" {
  bucket_prefix       = "${local.name}-audit-"
  object_lock_enabled = true
  force_destroy       = false
  tags                = merge(local.tags, { Purpose = "Immutable audit exports" })
  depends_on          = [terraform_data.compliance_gate]
}
resource "aws_s3_bucket_public_access_block" "audit" {
  bucket = aws_s3_bucket.audit.id
  block_public_acls = true
  block_public_policy = true
  ignore_public_acls = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "audit" { bucket = aws_s3_bucket.audit.id versioning_configuration { status = "Enabled" } }
resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule { default_retention { mode = "COMPLIANCE" years = var.audit_retention_years } }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "aws:kms" kms_master_key_id = aws_kms_key.data.arn } bucket_key_enabled = true }
}

data "aws_iam_policy_document" "audit_bucket" {
  statement {
    sid = "CloudTrailAclCheck"
    principals { type = "Service" identifiers = ["cloudtrail.amazonaws.com"] }
    actions = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.audit.arn]
  }
  statement {
    sid = "CloudTrailWrite"
    principals { type = "Service" identifiers = ["cloudtrail.amazonaws.com"] }
    actions = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]
    condition { test = "StringEquals" variable = "s3:x-amz-acl" values = ["bucket-owner-full-control"] }
  }
}
resource "aws_s3_bucket_policy" "audit" { bucket = aws_s3_bucket.audit.id policy = data.aws_iam_policy_document.audit_bucket.json }
resource "aws_cloudtrail" "security" {
  name                          = "${local.name}-security"
  s3_bucket_name                = aws_s3_bucket.audit.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  kms_key_id                    = aws_kms_key.data.arn
  depends_on                    = [aws_s3_bucket_policy.audit]
  tags                          = local.tags
}

resource "aws_vpc" "main" { cidr_block = "10.84.0.0/16" enable_dns_hostnames = true enable_dns_support = true tags = merge(local.tags,{Name=local.name}) }
resource "aws_internet_gateway" "main" { vpc_id = aws_vpc.main.id tags = local.tags }
resource "aws_subnet" "private" {
  count = 2
  vpc_id = aws_vpc.main.id
  cidr_block = cidrsubnet(aws_vpc.main.cidr_block,4,count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags = merge(local.tags,{Name="${local.name}-private-${count.index + 1}"})
}
resource "aws_security_group" "service" {
  name_prefix = "${local.name}-service-"
  vpc_id = aws_vpc.main.id
  egress { from_port=443 to_port=443 protocol="tcp" cidr_blocks=["0.0.0.0/0"] description="AWS API endpoints" }
  tags = local.tags
}
resource "aws_security_group" "database" {
  name_prefix = "${local.name}-database-"
  vpc_id = aws_vpc.main.id
  ingress { from_port=5432 to_port=5432 protocol="tcp" security_groups=[aws_security_group.service.id] description="Healthcare service only" }
  tags = local.tags
}
resource "aws_db_subnet_group" "main" { name = "${local.name}-db" subnet_ids = aws_subnet.private[*].id tags = local.tags }
resource "aws_db_instance" "clinical" {
  identifier                     = "${local.name}-clinical"
  engine                         = "postgres"
  engine_version                 = "16"
  instance_class                 = "db.t4g.micro"
  allocated_storage              = 20
  max_allocated_storage          = 100
  storage_type                   = "gp3"
  storage_encrypted              = true
  kms_key_id                     = aws_kms_key.data.arn
  db_name                        = "clinical"
  username                       = "kh_migrator"
  manage_master_user_password    = true
  master_user_secret_kms_key_id  = aws_kms_key.data.arn
  multi_az                       = false
  publicly_accessible            = false
  deletion_protection            = true
  backup_retention_period        = 35
  copy_tags_to_snapshot          = true
  auto_minor_version_upgrade     = true
  performance_insights_enabled   = true
  enabled_cloudwatch_logs_exports = ["postgresql","upgrade"]
  db_subnet_group_name           = aws_db_subnet_group.main.name
  vpc_security_group_ids         = [aws_security_group.database.id]
  skip_final_snapshot            = false
  final_snapshot_identifier      = "${local.name}-clinical-final"
  tags                           = local.tags
  depends_on                     = [terraform_data.compliance_gate]
}

resource "aws_cognito_user_pool" "staff" {
  name                     = "${local.name}-staff"
  mfa_configuration        = "ON"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  software_token_mfa_configuration { enabled = true }
  password_policy { minimum_length = 14 require_lowercase = true require_uppercase = true require_numbers = true require_symbols = true temporary_password_validity_days = 3 }
  account_recovery_setting { recovery_mechanism { name = "verified_email" priority = 1 } }
  tags = local.tags
}
resource "aws_cognito_user_pool_client" "staff" {
  name = "${local.name}-staff-api"
  user_pool_id = aws_cognito_user_pool.staff.id
  generate_secret = true
  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH","ALLOW_REFRESH_TOKEN_AUTH"]
  access_token_validity = 15
  id_token_validity = 15
  refresh_token_validity = 1
  token_validity_units { access_token="minutes" id_token="minutes" refresh_token="days" }
  prevent_user_existence_errors = "ENABLED"
}

output "documents_bucket" { value = aws_s3_bucket.documents.id }
output "staff_user_pool_id" { value = aws_cognito_user_pool.staff.id }
output "rds_master_secret_arn" { value = aws_db_instance.clinical.master_user_secret[0].secret_arn sensitive = true }
