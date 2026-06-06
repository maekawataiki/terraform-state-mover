# Service-app-api references IAM roles from infra-central by hardcoded ARN
data "aws_caller_identity" "current" {}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/e2e/service-app-api"
  retention_in_days = 1
}

resource "aws_lambda_function" "api_handler" {
  function_name = "e2e-app-api-handler"
  role          = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/e2e-app-api-lambda-exec"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  filename      = "${path.module}/lambda.zip"
}
