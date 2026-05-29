resource "aws_organizations_policy" "deny_iam_without_boundary" {
  name    = "deny-iam-without-boundary"
  type    = "SERVICE_CONTROL_POLICY"
  content = "{}"
}

resource "aws_iam_policy" "web_tier_boundary" {
  name   = "web-tier-boundary"
  policy = "{}"
}

resource "aws_iam_policy" "data_tier_boundary" {
  name   = "data-tier-boundary"
  policy = "{}"
}
