# Central IAM team manages ALL roles for every service
resource "aws_iam_role" "order_service_lambda" {
  name               = "order-service-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "order_service_rds" {
  name               = "order-service-rds-access"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "payment_service_lambda" {
  name               = "payment-service-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "payment_service_sqs" {
  name               = "payment-service-sqs"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "notification_service_lambda" {
  name               = "notification-service-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "notification_service_ses" {
  name               = "notification-service-ses"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "analytics_service_lambda" {
  name               = "analytics-service-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "analytics_service_s3" {
  name               = "analytics-service-s3-access"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "search_service_lambda" {
  name               = "search-service-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "search_service_opensearch" {
  name               = "search-service-opensearch"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "auth_service_lambda" {
  name               = "auth-service-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "auth_service_cognito" {
  name               = "auth-service-cognito"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "media_service_lambda" {
  name               = "media-service-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "media_service_s3" {
  name               = "media-service-s3-access"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "billing_service_lambda" {
  name               = "billing-service-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "billing_service_dynamodb" {
  name               = "billing-service-dynamodb"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

# Foundation: SCPs and Permission Boundaries
resource "aws_organizations_policy" "deny_iam_without_boundary" {
  name    = "deny-iam-without-boundary"
  content = "{}"
  type    = "SERVICE_CONTROL_POLICY"
}

resource "aws_iam_policy" "web_tier_boundary" {
  name   = "web-tier-boundary"
  policy = "{}"
}

resource "aws_iam_policy" "data_tier_boundary" {
  name   = "data-tier-boundary"
  policy = "{}"
}

resource "aws_iam_policy" "compute_tier_boundary" {
  name   = "compute-tier-boundary"
  policy = "{}"
}

# Platform: EKS + networking
resource "aws_iam_role" "eks_cluster_role" {
  name               = "eks-cluster-role"
  assume_role_policy = data.aws_iam_policy_document.eks_trust.json
}

resource "aws_iam_role" "eks_node_role" {
  name               = "eks-node-role"
  assume_role_policy = data.aws_iam_policy_document.eks_trust.json
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "private_a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_subnet" "private_b" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.2.0/24"
}

resource "aws_subnet" "public_a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.101.0/24"
}

resource "aws_eks_cluster" "main" {
  name     = "production"
  role_arn = aws_iam_role.eks_cluster_role.arn
}
