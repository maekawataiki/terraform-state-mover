resource "aws_lambda_function" "payment_handler" {
  function_name = "payment-handler"
  role          = "arn:aws:iam::111111111111:role/payment-service-lambda"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
}

resource "aws_lambda_function" "payment_webhook" {
  function_name = "payment-webhook"
  role          = "arn:aws:iam::111111111111:role/payment-service-lambda"
  handler       = "webhook.handler"
  runtime       = "nodejs18.x"
}

resource "aws_sqs_queue" "payment_events" {
  name = "payment-events"
}

resource "aws_dynamodb_table" "payment_ledger" {
  name     = "payment-ledger"
  hash_key = "id"
  attribute {
    name = "id"
    type = "S"
  }
}
