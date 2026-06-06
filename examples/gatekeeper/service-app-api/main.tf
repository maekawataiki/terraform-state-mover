resource "aws_lambda_function" "api_handler" {
  function_name = "app-api-handler"
  role          = "arn:aws:iam::111111111111:role/app-api-lambda-exec"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  filename      = "lambda.zip"
}

resource "aws_db_instance" "api_db" {
  identifier        = "app-api-db"
  engine            = "postgres"
  engine_version    = "15.4"
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  username          = "admin"
  password          = "changeme"
  skip_final_snapshot = true
}
