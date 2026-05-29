resource "aws_iam_policy" "web_tier_boundary_attachment" {
  name   = "web-tier-boundary-attachment"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:*", "apigateway:*", "logs:*"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_policy" "data_tier_boundary_attachment" {
  name   = "data-tier-boundary-attachment"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:*", "dynamodb:*", "rds:*"]
      Resource = "*"
    }]
  })
}
