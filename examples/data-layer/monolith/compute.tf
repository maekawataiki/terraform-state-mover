# --- Compute Layer ---

resource "aws_iam_role" "lambda_exec" {
  name               = "lambda-exec-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role" "rds_monitoring" {
  name               = "rds-enhanced-monitoring"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
    }]
  })
}

resource "aws_lambda_function" "order_processor" {
  function_name = "order-processor"
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  role          = aws_iam_role.lambda_exec.arn
  filename      = "dummy.zip"

  environment {
    variables = {
      DB_HOST    = aws_db_instance.main.endpoint
      CACHE_HOST = aws_elasticache_cluster.redis.cache_nodes[0].address
      STREAM_ARN = aws_kinesis_stream.events.arn
    }
  }
}

resource "aws_lambda_function" "payment_handler" {
  function_name = "payment-handler"
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  role          = aws_iam_role.lambda_exec.arn
  filename      = "dummy.zip"

  environment {
    variables = {
      DB_HOST      = aws_db_instance.main.endpoint
      SESSION_TABLE = aws_dynamodb_table.sessions.name
    }
  }
}

resource "aws_ecs_cluster" "main" {
  name = "app-cluster"
}

resource "aws_ecs_service" "api_service" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = "api:1"
  desired_count   = 3
}

resource "aws_s3_bucket" "deploy_artifacts" {
  bucket = "company-deploy-artifacts-ap-northeast-1"
}
