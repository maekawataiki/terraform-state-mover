# Resources moved by terraform-state-mover

resource "aws_iam_role" "app_analytics_s3_access" {
  name                 = "app-analytics-s3-access"
  assume_role_policy   = "{}"
  permissions_boundary = aws_iam_policy.data_tier_boundary.arn
}