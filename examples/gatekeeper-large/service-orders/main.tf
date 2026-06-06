resource "aws_lambda_function" "order_handler" {
  function_name = "order-handler"
  role          = "arn:aws:iam::111111111111:role/order-service-lambda"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  filename      = "lambda.zip"
}

resource "aws_lambda_function" "order_processor" {
  function_name = "order-processor"
  role          = "arn:aws:iam::111111111111:role/order-service-lambda"
  handler       = "processor.handler"
  runtime       = "nodejs18.x"
  filename      = "lambda.zip"
}

resource "aws_rds_cluster" "orders" {
  cluster_identifier  = "orders-db"
  engine              = "aurora-postgresql"
  engine_version      = "15.4"
  master_username     = "admin"
  master_password     = "changeme"
  skip_final_snapshot = true
}

resource "aws_sqs_queue" "order_events" {
  name = "order-events"
}
