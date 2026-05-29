data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket = "tf-state-111111111111"
    key    = "network/terraform.tfstate"
    region = "us-east-1"
  }
}

data "terraform_remote_state" "platform" {
  backend = "s3"
  config = {
    bucket = "tf-state-111111111111"
    key    = "platform/terraform.tfstate"
    region = "us-east-1"
  }
}

resource "aws_lambda_function" "order_api" {
  function_name = "order-api"
  role          = "arn:aws:iam::111111111111:role/platform-lambda-base-role"
  handler       = "order.handler"
  runtime       = "nodejs18.x"
  filename      = "lambda.zip"
  vpc_config {
    subnet_ids         = data.terraform_remote_state.network.outputs.private_subnet_ids
    security_group_ids = []
  }
}

resource "aws_lambda_function" "payment_processor" {
  function_name = "payment-processor"
  role          = "arn:aws:iam::111111111111:role/platform-service-deployer"
  handler       = "payment.handler"
  runtime       = "nodejs18.x"
  filename      = "lambda.zip"
}

resource "aws_lambda_function" "notification_sender" {
  function_name = "notification-sender"
  role          = "arn:aws:iam::111111111111:role/platform-lambda-base-role"
  handler       = "notify.handler"
  runtime       = "python3.11"
  filename      = "lambda.zip"
}
