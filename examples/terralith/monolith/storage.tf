resource "aws_s3_bucket" "data_lake" {
  bucket = "prod-data-lake"
}

resource "aws_s3_bucket" "logs" {
  bucket = "prod-application-logs"
}

resource "aws_s3_bucket" "static_assets" {
  bucket = "prod-static-assets"
}

resource "aws_dynamodb_table" "locks" {
  name         = "terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  attribute {
    name = "LockID"
    type = "S"
  }
}
