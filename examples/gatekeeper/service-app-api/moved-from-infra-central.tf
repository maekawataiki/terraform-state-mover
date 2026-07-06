# Resources moved by terraform-state-mover

resource "aws_iam_role" "app_api_db_access" {
  name                 = "app-api-db-access"
  assume_role_policy   = "{}"
  permissions_boundary = aws_iam_policy.data_tier_boundary.arn
}
resource "aws_iam_role" "app_api_lambda_exec" {
  name                 = "app-api-lambda-exec"
  assume_role_policy   = "{}"
  permissions_boundary = aws_iam_policy.web_tier_boundary.arn
}