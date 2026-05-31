resource "aws_lambda_function" "auth_handler" {
  function_name = "auth-handler"
  role          = "arn:aws:iam::111111111111:role/auth-service-lambda"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
}

resource "aws_cognito_user_pool" "main" {
  name = "main-user-pool"
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "web-client"
  user_pool_id = aws_cognito_user_pool.main.id
}
