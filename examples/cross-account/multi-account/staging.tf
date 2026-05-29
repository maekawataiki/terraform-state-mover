resource "aws_ecs_cluster" "staging" {
  provider = aws.staging
  name     = "staging-cluster"
}

resource "aws_ecs_service" "staging_app" {
  provider        = aws.staging
  name            = "staging-app"
  cluster         = aws_ecs_cluster.staging.id
  task_definition = "app:1"
  desired_count   = 1
}

resource "aws_iam_role" "staging_ecs_task" {
  provider           = aws.staging
  name               = "staging-ecs-task-role"
  assume_role_policy = "{}"
}

resource "aws_s3_bucket" "staging_data" {
  provider = aws.staging
  bucket   = "staging-data-111111111111"
}

resource "aws_route53_record" "staging_app" {
  provider = aws.shared
  zone_id  = aws_route53_zone.shared.zone_id
  name     = "staging-app.internal.example.com"
  type     = "CNAME"
  ttl      = 300
  records  = ["staging-alb.example.com"]
}
