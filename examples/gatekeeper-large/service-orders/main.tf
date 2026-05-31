resource "aws_lambda_function" "order_handler" {
  function_name = "order-handler"
  role          = "arn:aws:iam::111111111111:role/order-service-lambda"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
}

resource "aws_lambda_function" "order_processor" {
  function_name = "order-processor"
  role          = "arn:aws:iam::111111111111:role/order-service-lambda"
  handler       = "processor.handler"
  runtime       = "nodejs18.x"
}

resource "aws_rds_cluster" "orders" {
  cluster_identifier = "orders-db"
  engine             = "aurora-postgresql"
  master_username    = "admin"
  master_password    = "changeme"
}

resource "aws_sqs_queue" "order_events" {
  name = "order-events"
}
