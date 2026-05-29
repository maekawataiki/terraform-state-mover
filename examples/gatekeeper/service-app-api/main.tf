resource "aws_lambda_function" "api_handler" {
  function_name = "app-api-handler"
  role          = "arn:aws:iam::111111111111:role/app-api-lambda-exec"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  filename      = "lambda.zip"
}

resource "aws_db_instance" "api_db" {
  identifier     = "app-api-db"
  engine         = "postgres"
  instance_class = "db.t3.micro"
}
