resource "aws_lambda_function" "search_api" {
  function_name = "search-api"
  role          = "arn:aws:iam::111111111111:role/search-service-lambda"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
}

resource "aws_opensearch_domain" "main" {
  domain_name    = "search"
  engine_version = "OpenSearch_2.11"
}
