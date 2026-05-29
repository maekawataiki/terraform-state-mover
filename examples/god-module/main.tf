module "mega_service" {
  source = "./modules/mega"

  vpc_id              = var.vpc_id
  subnet_ids          = var.subnet_ids
  security_group_id   = var.security_group_id
  cluster_name        = var.cluster_name
  instance_type       = var.instance_type
  min_size            = var.min_size
  max_size            = var.max_size
  desired_capacity    = var.desired_capacity
  ami_id              = var.ami_id
  key_name            = var.key_name
  iam_role_arn        = var.iam_role_arn
  certificate_arn     = var.certificate_arn
  domain_name         = var.domain_name
  hosted_zone_id      = var.hosted_zone_id
  log_bucket          = var.log_bucket
}

resource "aws_cloudwatch_log_group" "mega" {
  name = "/mega-service/logs"
}
