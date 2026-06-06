resource "aws_lambda_function" "notification_sender" {
  function_name = "notification-sender"
  role          = "arn:aws:iam::111111111111:role/notification-service-lambda"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  filename      = "lambda.zip"
}

resource "aws_ses_domain_identity" "main" {
  domain = "example.com"
}

resource "aws_sns_topic" "alerts" {
  name = "alerts"
}
