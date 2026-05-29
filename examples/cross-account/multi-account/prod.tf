resource "aws_ecs_cluster" "prod" {
  provider = aws.prod
  name     = "prod-cluster"
}

resource "aws_ecs_service" "prod_app" {
  provider        = aws.prod
  name            = "prod-app"
  cluster         = aws_ecs_cluster.prod.id
  task_definition = "app:1"
  desired_count   = 3
}

resource "aws_iam_role" "prod_ecs_task" {
  provider           = aws.prod
  name               = "prod-ecs-task-role"
  assume_role_policy = "{}"
}

resource "aws_s3_bucket" "prod_data" {
  provider = aws.prod
  bucket   = "prod-data-111111111111"
}

resource "aws_route53_record" "prod_app" {
  provider = aws.shared
  zone_id  = aws_route53_zone.shared.zone_id
  name     = "app.internal.example.com"
  type     = "CNAME"
  ttl      = 300
  records  = ["prod-alb.example.com"]
}
