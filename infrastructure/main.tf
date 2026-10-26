terraform {
  required_version = ">= 1.8.0"
  backend "s3" {}
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
data "aws_availability_zones" "available" {
  state = "available"
}

variable "region" {
  type    = string
  default = "us-east-1"
}
variable "environment" {
  type    = string
  default = "production"
}
variable "expected_account_id" {
  type = string
}
variable "baa_attested" {
  type        = bool
  default     = false
  description = "Set only after an authorized Kantage representative accepts the AWS BAA for this healthcare account."
}
variable "audit_retention_years" {
  type        = number
  description = "Legal retention period for immutable audit exports. Object Lock retention cannot be shortened."
  validation {
    condition     = var.audit_retention_years >= 1 && var.audit_retention_years <= 100
    error_message = "Set a retention period from 1 to 100 years."
  }
}
variable "api_image_uri" {
  type        = string
  default     = null
  description = "Immutable ECR image URI for the Kantage Healthcare API."
}
variable "tenant_registry_secret_arn" {
  type        = string
  default     = null
  sensitive   = true
  description = "Secrets Manager ARN containing the tenant registry used by the API."
}
variable "api_certificate_arn" {
  type        = string
  default     = null
  description = "ACM certificate ARN for the HTTPS API hostname."
}
variable "enable_api_service" {
  type        = bool
  default     = false
  description = "Creates NAT, public load balancer, and ECS tasks only after an immutable image, tenant secret, and ACM certificate are ready."
}
variable "api_desired_count" {
  type    = number
  default = 2
  validation {
    condition     = var.api_desired_count >= 2 && var.api_desired_count <= 10
    error_message = "Run at least two API tasks for deployment and availability resilience."
  }
}

variable "staff_portal_image_uri" {
  type        = string
  default     = null
  description = "Immutable ECR image URI for the Kantage Health Staff Portal."
}
variable "enable_staff_portal" {
  type        = bool
  default     = false
  description = "Creates the Staff Portal ECS service and HTTPS host route after an immutable image is available."
}
variable "staff_portal_hostname" {
  type        = string
  default     = "portal.health.kantage.solutions"
  description = "Public hostname for the authenticated Kantage Health Staff Portal."
}
variable "portal_hostnames" {
  type        = list(string)
  default     = ["portal.health.kantage.solutions", "admin.health.kantage.solutions", "staff.health.kantage.solutions", "patient.health.kantage.solutions"]
  description = "HTTPS hostnames routed to the portal frontend. The ACM certificate must cover every name before enabling these routes."
}
variable "github_oidc_subject" {
  type        = string
  default     = "repo:kantagesolutions@290776816/kantagehealth@1380699237:environment:production"
  description = "Exact GitHub OIDC subject allowed to deploy production. GitHub includes immutable organization and repository IDs."
}
variable "github_oidc_provider_arn" {
  type        = string
  default     = null
  description = "Existing GitHub Actions OIDC provider ARN. Leave null to create it in this account."
}
variable "enable_staff_mfa" {
  type        = bool
  default     = false
  description = "Require software token MFA for workforce users. Keep false during the current controlled testing phase."
}

locals {
  name                     = "kantage-healthcare-${var.environment}"
  github_oidc_provider_arn = var.github_oidc_provider_arn != null ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
  tags = {
    Application = "Kantage Healthcare"
    Environment = var.environment
    ManagedBy   = "Terraform"
    DataClass   = "PHI"
  }
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_oidc_provider_arn == null ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  tags           = local.tags
}

data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [var.github_oidc_subject]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${local.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_deploy_assume.json
  tags               = local.tags
}

resource "terraform_data" "compliance_gate" {
  input = local.name
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "Refusing to create healthcare resources in an unexpected AWS account."
    }
    precondition {
      condition     = var.baa_attested
      error_message = "Refusing to create PHI-capable resources until the AWS BAA is accepted and attested."
    }
  }
}

resource "terraform_data" "api_deployment_gate" {
  count = var.enable_api_service ? 1 : 0
  input = local.name
  lifecycle {
    precondition {
      condition     = var.api_image_uri != null && var.tenant_registry_secret_arn != null && var.api_certificate_arn != null
      error_message = "Enable the API only with an immutable image URI, tenant registry secret ARN, and issued ACM certificate ARN."
    }
  }
}

resource "terraform_data" "staff_portal_deployment_gate" {
  count = var.enable_staff_portal ? 1 : 0
  input = local.name
  lifecycle {
    precondition {
      condition     = var.enable_api_service && var.staff_portal_image_uri != null && var.api_certificate_arn != null
      error_message = "Enable the Staff Portal only after the API, an immutable portal image, and an issued ACM certificate are ready."
    }
  }
}

data "aws_iam_policy_document" "data_key" {
  statement {
    sid    = "EnableAccountAdministration"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }
  statement {
    sid    = "AllowCloudTrailEncryption"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    actions   = ["kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
  }
  statement {
    sid    = "AllowCloudWatchLogsEncryption"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
  }
}

resource "aws_kms_key" "data" {
  description             = "Kantage Healthcare PHI encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.data_key.json
  tags                    = local.tags
}
resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-phi"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_s3_bucket" "documents" {
  bucket_prefix = "kh-${var.environment}-docs-"
  force_destroy = false
  tags          = local.tags
  depends_on    = [terraform_data.compliance_gate]
}
resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket" "audit" {
  bucket_prefix       = "kh-${var.environment}-audit-"
  object_lock_enabled = true
  force_destroy       = false
  tags                = merge(local.tags, { Purpose = "Immutable audit exports" })
  depends_on          = [terraform_data.compliance_gate]
}
resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    default_retention {
      mode  = "COMPLIANCE"
      years = var.audit_retention_years
    }
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "audit_bucket" {
  statement {
    sid = "CloudTrailAclCheck"
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.audit.arn]
  }
  statement {
    sid = "CloudTrailWrite"
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}
resource "aws_s3_bucket_policy" "audit" {
  bucket = aws_s3_bucket.audit.id
  policy = data.aws_iam_policy_document.audit_bucket.json
}
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

resource "aws_vpc" "main" {
  cidr_block           = "10.84.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = merge(local.tags, { Name = local.name })
}
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = local.tags
}
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 4, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = merge(local.tags, { Name = "${local.name}-private-${count.index + 1}" })
}
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 4, count.index + 2)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Name = "${local.name}-public-${count.index + 1}" })
}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = merge(local.tags, { Name = "${local.name}-public" })
}
resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
resource "aws_eip" "nat" {
  count  = var.enable_api_service ? 1 : 0
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${local.name}-nat" })
}
resource "aws_nat_gateway" "main" {
  count         = var.enable_api_service ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]
  tags          = merge(local.tags, { Name = "${local.name}-nat" })
}
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${local.name}-private" })
}
resource "aws_route" "private_internet" {
  count                  = var.enable_api_service ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[0].id
}
resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
resource "aws_security_group" "load_balancer" {
  count       = var.enable_api_service ? 1 : 0
  name_prefix = "${local.name}-alb-"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Redirect public HTTP to HTTPS"
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Public HTTPS API and booking traffic"
  }
  egress {
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
    description = "Healthcare API tasks only"
  }
  dynamic "egress" {
    for_each = var.enable_staff_portal ? [1] : []
    content {
      from_port   = 8080
      to_port     = 8080
      protocol    = "tcp"
      cidr_blocks = [aws_vpc.main.cidr_block]
      description = "Staff Portal tasks only"
    }
  }
  tags = local.tags
}
resource "aws_security_group" "service" {
  name_prefix = "${local.name}-service-"
  vpc_id      = aws_vpc.main.id
  dynamic "ingress" {
    for_each = var.enable_api_service ? [1] : []
    content {
      from_port       = 3000
      to_port         = 3000
      protocol        = "tcp"
      security_groups = [aws_security_group.load_balancer[0].id]
      description     = "HTTPS load balancer only"
    }
  }
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "AWS API endpoints"
  }
  egress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
    description = "Private PostgreSQL only"
  }
  tags = local.tags
}
resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
  tags = local.tags
}
resource "aws_cloudwatch_log_group" "api" {
  name              = "/kantage-healthcare/${var.environment}/api"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.tags
}
resource "aws_ecs_cluster" "api" {
  name = "${local.name}-api"
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
  tags = local.tags
}
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "api_execution" {
  name               = "${local.name}-api-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}
resource "aws_iam_role_policy_attachment" "api_execution" {
  role       = aws_iam_role.api_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ECS uses the execution role to inject the registry secret into the task.
# Limit it to this one encrypted registry; runtime access remains on the task role.
data "aws_iam_policy_document" "api_execution_registry" {
  count = var.enable_api_service ? 1 : 0

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.tenant_registry_secret_arn]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}
resource "aws_iam_role_policy" "api_execution_registry" {
  count  = var.enable_api_service ? 1 : 0
  name   = "${local.name}-api-registry"
  role   = aws_iam_role.api_execution.id
  policy = data.aws_iam_policy_document.api_execution_registry[0].json
}
resource "aws_iam_role" "api_task" {
  name               = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}
data "aws_iam_policy_document" "api_task" {
  statement {
    actions = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
    resources = concat(
      var.tenant_registry_secret_arn == null ? [] : [var.tenant_registry_secret_arn],
      [
        "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:${local.name}-*"
      ]
    )
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.documents.arn}/*"]
  }
  statement {
    actions = [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminAddUserToGroup"
    ]
    # Staff onboarding writes to the workforce pool; patient portal enablement
    # writes to the patient pool. The API needs both, not one or the other.
    resources = [aws_cognito_user_pool.workforce.arn, aws_cognito_user_pool.staff.arn]
  }
  statement {
    actions   = ["sns:Publish"]
    resources = ["*"]
  }
}
resource "aws_iam_role_policy" "api_task" {
  name   = "${local.name}-api-runtime"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json
}
resource "aws_lb" "api" {
  count = var.enable_api_service ? 1 : 0
  # AWS Application Load Balancer names are limited to 32 characters.
  name                       = "kh-${var.environment}-api"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.load_balancer[0].id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  enable_deletion_protection = true
  tags                       = local.tags
}
resource "aws_lb_target_group" "api" {
  count       = var.enable_api_service ? 1 : 0
  name_prefix = "khapi-"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    enabled             = true
    path                = "/healthz"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 15
  }
  tags = local.tags
}
resource "aws_lb_listener" "http" {
  count             = var.enable_api_service ? 1 : 0
  load_balancer_arn = aws_lb.api[0].arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
resource "aws_lb_listener" "https" {
  count             = var.enable_api_service ? 1 : 0
  load_balancer_arn = aws_lb.api[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.api_certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[0].arn
  }
}
resource "aws_ecs_task_definition" "api" {
  count                    = var.enable_api_service ? 1 : 0
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.api_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = "api"
    image        = var.api_image_uri
    essential    = true
    portMappings = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3000" },
      { name = "PATIENT_USER_POOL_ID", value = aws_cognito_user_pool.staff.id },
      { name = "WORKFORCE_USER_POOL_ID", value = aws_cognito_user_pool.workforce.id },
      { name = "WORKFORCE_PORTAL_CLIENT_ID", value = aws_cognito_user_pool_client.workforce_portals.id },
      # The API expects the registry secret's identifier and looks the secret up itself.
      # Declaring this under `secrets` made ECS resolve it, injecting the registry
      # contents where an ARN was expected, so every registry read failed.
      { name = "KANTAGE_TENANT_REGISTRY_SECRET_ID", value = var.tenant_registry_secret_arn }
    ]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.api.name, awslogs-region = var.region, awslogs-stream-prefix = "api" } }
    healthCheck      = { command = ["CMD-SHELL", "node -e \"require('http').get('http://localhost:3000/healthz',res=>process.exit(res.statusCode===200?0:1)).on('error',()=>process.exit(1))\""], interval = 30, timeout = 5, retries = 3, startPeriod = 20 }
  }])
  tags = local.tags
}
resource "aws_ecs_service" "api" {
  count                              = var.enable_api_service ? 1 : 0
  name                               = "${local.name}-api"
  cluster                            = aws_ecs_cluster.api.id
  task_definition                    = aws_ecs_task_definition.api[0].arn
  desired_count                      = var.api_desired_count
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api[0].arn
    container_name   = "api"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener.https, terraform_data.api_deployment_gate]
  tags       = local.tags
  lifecycle { ignore_changes = [task_definition] }
}

resource "aws_iam_role" "migration_task" {
  count              = var.enable_api_service ? 1 : 0
  name               = "${local.name}-migration-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}
data "aws_iam_policy_document" "migration_task" {
  count = var.enable_api_service ? 1 : 0
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.clinical.master_user_secret[0].secret_arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}
resource "aws_iam_role_policy" "migration_task" {
  count  = var.enable_api_service ? 1 : 0
  name   = "${local.name}-migration-runtime"
  role   = aws_iam_role.migration_task[0].id
  policy = data.aws_iam_policy_document.migration_task[0].json
}
resource "aws_ecs_task_definition" "migration" {
  count                    = var.enable_api_service ? 1 : 0
  family                   = "${local.name}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.api_execution.arn
  task_role_arn            = aws_iam_role.migration_task[0].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name      = "migration"
    image     = var.api_image_uri
    essential = true
    command   = ["node", "dist/scripts/migrate.js"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "DATABASE_SECRET_ID", value = aws_db_instance.clinical.master_user_secret[0].secret_arn },
      { name = "DATABASE_HOST", value = aws_db_instance.clinical.address },
      { name = "DATABASE_NAME", value = aws_db_instance.clinical.db_name }
    ]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.api.name, awslogs-region = var.region, awslogs-stream-prefix = "migration" } }
  }])
  tags = local.tags
}
resource "aws_ecr_repository" "staff_portal" {
  name                 = "${local.name}-staff-portal"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
  tags = local.tags
}
resource "aws_cloudwatch_log_group" "staff_portal" {
  count             = var.enable_staff_portal ? 1 : 0
  name              = "/kantage-healthcare/${var.environment}/staff-portal"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.tags
}
resource "aws_iam_role" "staff_portal_execution" {
  count              = var.enable_staff_portal ? 1 : 0
  name               = "${local.name}-staff-portal-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}
resource "aws_iam_role_policy_attachment" "staff_portal_execution" {
  count      = var.enable_staff_portal ? 1 : 0
  role       = aws_iam_role.staff_portal_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_security_group" "staff_portal_service" {
  count       = var.enable_staff_portal ? 1 : 0
  name_prefix = "${local.name}-staff-portal-"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.load_balancer[0].id]
    description     = "HTTPS load balancer only"
  }
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "AWS service endpoints"
  }
  tags = local.tags
}
resource "aws_lb_target_group" "staff_portal" {
  count       = var.enable_staff_portal ? 1 : 0
  name_prefix = "khptl-"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    enabled             = true
    path                = "/"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 15
  }
  tags = local.tags
}
resource "aws_lb_listener_rule" "staff_portal" {
  count        = var.enable_staff_portal ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.staff_portal[0].arn
  }
  condition {
    host_header { values = var.portal_hostnames }
  }
  tags = local.tags
}
resource "aws_ecs_task_definition" "staff_portal" {
  count                    = var.enable_staff_portal ? 1 : 0
  family                   = "${local.name}-staff-portal"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.staff_portal_execution[0].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = "staff-portal"
    image        = var.staff_portal_image_uri
    essential    = true
    portMappings = [{ containerPort = 8080, hostPort = 8080, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "WORKFORCE_PORTAL_CLIENT_ID", value = aws_cognito_user_pool_client.workforce_portals.id },
      { name = "WORKFORCE_LOGIN_DOMAIN", value = "https://${aws_cognito_user_pool_domain.workforce.domain}.auth.${var.region}.amazoncognito.com" },
      { name = "PATIENT_PORTAL_CLIENT_ID", value = aws_cognito_user_pool_client.portals.id },
      { name = "PATIENT_LOGIN_DOMAIN", value = "https://${aws_cognito_user_pool_domain.portals.domain}.auth.${var.region}.amazoncognito.com" }
    ]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.staff_portal[0].name, awslogs-region = var.region, awslogs-stream-prefix = "portal" } }
    healthCheck      = { command = ["CMD-SHELL", "wget -q -O /dev/null http://localhost:8080/ || exit 1"], interval = 30, timeout = 5, retries = 3, startPeriod = 20 }
  }])
  tags = local.tags
}
resource "aws_ecs_service" "staff_portal" {
  count                              = var.enable_staff_portal ? 1 : 0
  name                               = "${local.name}-staff-portal"
  cluster                            = aws_ecs_cluster.api.id
  task_definition                    = aws_ecs_task_definition.staff_portal[0].arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.staff_portal_service[0].id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.staff_portal[0].arn
    container_name   = "staff-portal"
    container_port   = 8080
  }
  depends_on = [aws_lb_listener_rule.staff_portal, terraform_data.staff_portal_deployment_gate]
  tags       = local.tags
  lifecycle { ignore_changes = [task_definition] }
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
      "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload",
      "ecr:PutImage", "ecr:UploadLayerPart"
    ]
    resources = [aws_ecr_repository.api.arn, aws_ecr_repository.staff_portal.arn]
  }
  statement {
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }
  statement {
    actions = ["ecs:RegisterTaskDefinition"]
    resources = [
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-api:*",
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-staff-portal:*",
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-migration:*"
    ]
  }
  statement {
    actions = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = [
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:service/${local.name}-api/${local.name}-api",
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:service/${local.name}-api/${local.name}-staff-portal"
    ]
  }
  statement {
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-migration:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.api.arn]
    }
  }
  statement {
    actions   = ["ecs:DescribeTasks"]
    resources = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task/${local.name}-api/*"]
  }
  statement {
    actions = ["iam:PassRole"]
    resources = concat(
      [aws_iam_role.api_execution.arn, aws_iam_role.api_task.arn],
      var.enable_api_service ? [aws_iam_role.migration_task[0].arn] : [],
      var.enable_staff_portal ? [aws_iam_role.staff_portal_execution[0].arn] : []
    )
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role_policy" "github_deploy" {
  name   = "${local.name}-github-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

resource "aws_security_group" "database" {
  name_prefix = "${local.name}-database-"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
    description     = "Healthcare service only"
  }
  tags = local.tags
}
resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = aws_subnet.private[*].id
  tags       = local.tags
}
resource "aws_db_parameter_group" "clinical" {
  name   = "${local.name}-postgres16"
  family = "postgres16"
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
  tags = local.tags
}
resource "aws_db_instance" "clinical" {
  identifier                      = "${local.name}-clinical"
  engine                          = "postgres"
  engine_version                  = "16"
  instance_class                  = "db.t4g.micro"
  allocated_storage               = 20
  max_allocated_storage           = 100
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  db_name                         = "clinical"
  username                        = "kh_migrator"
  manage_master_user_password     = true
  master_user_secret_kms_key_id   = aws_kms_key.data.arn
  multi_az                        = false
  publicly_accessible             = false
  deletion_protection             = true
  backup_retention_period         = 35
  copy_tags_to_snapshot           = true
  auto_minor_version_upgrade      = true
  performance_insights_enabled    = true
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  db_subnet_group_name            = aws_db_subnet_group.main.name
  parameter_group_name            = aws_db_parameter_group.clinical.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.name}-clinical-final"
  tags                            = local.tags
  depends_on                      = [terraform_data.compliance_gate]
}

resource "aws_cognito_user_pool" "staff" {
  name                     = "${local.name}-staff"
  mfa_configuration        = var.enable_staff_mfa ? "ON" : "OFF"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  dynamic "software_token_mfa_configuration" {
    for_each = var.enable_staff_mfa ? [1] : []
    content {
      enabled = true
    }
  }
  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
  tags = local.tags
}

resource "aws_cognito_user_pool" "workforce" {
  name              = "${local.name}-workforce"
  mfa_configuration = var.enable_staff_mfa ? "ON" : "OFF"
  username_configuration { case_sensitive = false }
  auto_verified_attributes = ["email"]
  # Staff and administrators are only ever invited. Without this the hosted sign-in page offers
  # "Create an account", letting anyone on the internet register into the workforce pool.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }
  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
  }
  dynamic "software_token_mfa_configuration" {
    for_each = var.enable_staff_mfa ? [1] : []
    content { enabled = true }
  }
  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
  tags = local.tags
}
resource "aws_cognito_user_pool_client" "staff" {
  name                   = "${local.name}-staff-api"
  user_pool_id           = aws_cognito_user_pool.staff.id
  generate_secret        = true
  explicit_auth_flows    = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  access_token_validity  = 15
  id_token_validity      = 15
  refresh_token_validity = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
  prevent_user_existence_errors = "ENABLED"
}
resource "aws_cognito_user_group" "platform_admin" {
  name         = "platform_admin"
  user_pool_id = aws_cognito_user_pool.staff.id
  description  = "D.A.Y Health Systems platform administrators"
}
resource "aws_cognito_user_group" "dentalems_staff" {
  name         = "dentalems_staff"
  user_pool_id = aws_cognito_user_pool.staff.id
  description  = "DentalEMS clinic employees"
}
resource "aws_cognito_user_group" "dentalems_patient" {
  name         = "dentalems_patient"
  user_pool_id = aws_cognito_user_pool.staff.id
  description  = "DentalEMS patient portal accounts"
}
resource "aws_cognito_user_group" "workforce_platform_admin" {
  name         = "platform_admin"
  user_pool_id = aws_cognito_user_pool.workforce.id
  description  = "D.A.Y Health Systems platform administrators"
}
resource "aws_cognito_user_group" "workforce_dentalems_staff" {
  name         = "dentalems_staff"
  user_pool_id = aws_cognito_user_pool.workforce.id
  description  = "DentalEMS clinic employees"
}
resource "aws_cognito_user_pool_domain" "portals" {
  domain       = "kantage-healthcare-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.staff.id
}
resource "aws_cognito_user_pool_client" "portals" {
  name                                 = "${local.name}-portals"
  user_pool_id                         = aws_cognito_user_pool.staff.id
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["https://patient.health.kantage.solutions/"]
  logout_urls                          = ["https://patient.health.kantage.solutions/"]
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  access_token_validity                = 15
  id_token_validity                    = 15
  refresh_token_validity               = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
  prevent_user_existence_errors = "ENABLED"
}
resource "aws_cognito_user_pool_domain" "workforce" {
  domain       = "day-health-workforce-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.workforce.id
}
resource "aws_cognito_user_pool_client" "workforce_portals" {
  name                                 = "${local.name}-workforce-portals"
  user_pool_id                         = aws_cognito_user_pool.workforce.id
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = [for hostname in ["admin.health.kantage.solutions", "staff.health.kantage.solutions"] : "https://${hostname}/"]
  logout_urls                          = [for hostname in ["admin.health.kantage.solutions", "staff.health.kantage.solutions"] : "https://${hostname}/"]
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  access_token_validity                = 15
  id_token_validity                    = 15
  refresh_token_validity               = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
  prevent_user_existence_errors = "ENABLED"
}

output "documents_bucket" {
  value = aws_s3_bucket.documents.id
}
output "staff_user_pool_id" {
  value = aws_cognito_user_pool.staff.id
}
output "portal_user_pool_client_id" {
  value = aws_cognito_user_pool_client.portals.id
}
output "portal_login_domain" {
  value = "https://${aws_cognito_user_pool_domain.portals.domain}.auth.${var.region}.amazoncognito.com"
}
output "workforce_user_pool_id" {
  value = aws_cognito_user_pool.workforce.id
}
output "workforce_portal_client_id" {
  value = aws_cognito_user_pool_client.workforce_portals.id
}
output "workforce_login_domain" {
  value = "https://${aws_cognito_user_pool_domain.workforce.domain}.auth.${var.region}.amazoncognito.com"
}
output "rds_master_secret_arn" {
  value     = aws_db_instance.clinical.master_user_secret[0].secret_arn
  sensitive = true
}
output "api_ecr_repository_url" { value = aws_ecr_repository.api.repository_url }
output "api_cluster_name" { value = aws_ecs_cluster.api.name }
output "api_load_balancer_dns_name" { value = try(aws_lb.api[0].dns_name, null) }
output "staff_portal_ecr_repository_url" { value = try(aws_ecr_repository.staff_portal.repository_url, null) }
output "staff_portal_url" { value = var.enable_staff_portal ? "https://${var.staff_portal_hostname}" : null }
output "admin_portal_url" { value = var.enable_staff_portal ? "https://admin.health.kantage.solutions" : null }
output "clinic_staff_portal_url" { value = var.enable_staff_portal ? "https://staff.health.kantage.solutions" : null }
output "patient_portal_url" { value = var.enable_staff_portal ? "https://patient.health.kantage.solutions" : null }
output "github_deploy_role_arn" { value = aws_iam_role.github_deploy.arn }
output "migration_task_family" { value = try(aws_ecs_task_definition.migration[0].family, null) }
