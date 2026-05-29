resource "aws_lambda_function" "api_handler" {
  function_name = "api-handler"
  role          = aws_iam_role.lambda_api.arn
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  filename      = "lambda.zip"
  vpc_config {
    subnet_ids         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_group_ids = []
  }
}

resource "aws_lambda_function" "event_processor" {
  function_name = "event-processor"
  role          = aws_iam_role.lambda_events.arn
  handler       = "process.handler"
  runtime       = "python3.11"
  filename      = "lambda.zip"
}

resource "aws_lambda_function" "data_pipeline" {
  function_name = "data-pipeline"
  role          = aws_iam_role.lambda_data.arn
  handler       = "pipeline.handler"
  runtime       = "python3.11"
  filename      = "lambda.zip"
}

resource "aws_ecs_service" "web" {
  name            = "web-frontend"
  cluster         = aws_eks_cluster.main.arn
  task_definition = "web-frontend:1"
  desired_count   = 3
}
