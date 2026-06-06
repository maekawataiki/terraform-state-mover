# Platform repo: owns IAM roles that services reference by hardcoded ARN
data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_base" {
  name               = "e2e-platform-lambda-base-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role_policy_attachment" "lambda_base_exec" {
  role       = aws_iam_role.lambda_base.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role" "service_deployer" {
  name               = "e2e-platform-service-deployer"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role_policy_attachment" "service_deployer_exec" {
  role       = aws_iam_role.service_deployer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

output "lambda_base_role_arn" {
  value = aws_iam_role.lambda_base.arn
}

output "deployer_role_arn" {
  value = aws_iam_role.service_deployer.arn
}
