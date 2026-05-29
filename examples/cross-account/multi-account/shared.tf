resource "aws_ecr_repository" "app" {
  provider = aws.shared
  name     = "app-container"
}

resource "aws_s3_bucket" "shared_config" {
  provider = aws.shared
  bucket   = "shared-config-111111111111"
}

resource "aws_iam_role" "cross_account_reader" {
  provider           = aws.shared
  name               = "cross-account-reader"
  assume_role_policy = "{}"
}

resource "aws_route53_zone" "shared" {
  provider = aws.shared
  name     = "internal.example.com"
}
