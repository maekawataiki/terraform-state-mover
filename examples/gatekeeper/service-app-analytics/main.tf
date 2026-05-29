resource "aws_lambda_function" "analytics_ingest" {
  function_name = "app-analytics-ingest"
  role          = "arn:aws:iam::111111111111:role/app-analytics-s3-access"
  handler       = "ingest.handler"
  runtime       = "python3.11"
  filename      = "lambda.zip"
}

resource "aws_s3_bucket" "analytics_data" {
  bucket = "app-analytics-data-bucket"
}
