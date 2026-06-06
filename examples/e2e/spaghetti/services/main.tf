# Services repo: references platform roles by hardcoded ARN and network via remote_state
data "aws_caller_identity" "current" {}

data "terraform_remote_state" "network" {
  backend = "local"
  config = {
    path = "../network/terraform.tfstate"
  }
}

# Security group demonstrating cross-repo VPC dependency via remote_state
resource "aws_security_group" "lambda" {
  name   = "e2e-spaghetti-lambda-sg"
  vpc_id = data.terraform_remote_state.network.outputs.vpc_id
}

# Lambda using hardcoded ARN from platform repo (spaghetti anti-pattern)
resource "aws_lambda_function" "order_api" {
  function_name = "e2e-order-api"
  role          = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/e2e-platform-lambda-base-role"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  filename      = "${path.module}/lambda.zip"
}

# Another Lambda using different hardcoded ARN
resource "aws_lambda_function" "payment_processor" {
  function_name = "e2e-payment-processor"
  role          = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/e2e-platform-service-deployer"
  handler       = "payment.handler"
  runtime       = "nodejs20.x"
  filename      = "${path.module}/lambda.zip"
}
