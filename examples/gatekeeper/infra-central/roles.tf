resource "aws_iam_role" "app_api_lambda_exec" {
  name                 = "app-api-lambda-exec"
  assume_role_policy   = "{}"
  permissions_boundary = aws_iam_policy.web_tier_boundary.arn
}

resource "aws_iam_role" "app_api_db_access" {
  name                 = "app-api-db-access"
  assume_role_policy   = "{}"
  permissions_boundary = aws_iam_policy.data_tier_boundary.arn
}

resource "aws_iam_role" "app_analytics_s3_access" {
  name                 = "app-analytics-s3-access"
  assume_role_policy   = "{}"
  permissions_boundary = aws_iam_policy.data_tier_boundary.arn
}

resource "aws_iam_role" "eks_cluster_role" {
  name               = "eks-cluster-role"
  assume_role_policy = "{}"
}

resource "aws_iam_role" "events_processor_role" {
  name               = "events-processor-role"
  assume_role_policy = "{}"
}
