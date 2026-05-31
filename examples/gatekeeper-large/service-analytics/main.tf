resource "aws_lambda_function" "analytics_ingest" {
  function_name = "analytics-ingest"
  role          = "arn:aws:iam::111111111111:role/analytics-service-lambda"
  handler       = "index.handler"
  runtime       = "python3.11"
}

resource "aws_lambda_function" "analytics_transform" {
  function_name = "analytics-transform"
  role          = "arn:aws:iam::111111111111:role/analytics-service-lambda"
  handler       = "transform.handler"
  runtime       = "python3.11"
}

resource "aws_s3_bucket" "data_lake" {
  bucket = "analytics-data-lake"
}

resource "aws_kinesis_stream" "events" {
  name        = "analytics-events"
  shard_count = 2
}
