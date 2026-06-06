# Central IAM team manages service-specific roles (anti-pattern)

# This role belongs to service-app-api but is managed centrally (gatekeeper anti-pattern)
resource "aws_iam_role" "app_api_lambda_exec" {
  name = "e2e-app-api-lambda-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
  managed_policy_arns = ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]
}

# This role also belongs to service-app-api
resource "aws_iam_role" "app_api_db_access" {
  name = "e2e-app-api-db-access"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

# This role is platform-level (should stay here)
resource "aws_iam_role" "platform_deployer" {
  name = "e2e-platform-deployer"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}
