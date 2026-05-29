resource "aws_ecs_cluster" "prod_app" {
  name = "prod-app-cluster"
}

resource "aws_s3_bucket" "prod_data" {
  bucket = "prod-data-bucket"
}

resource "aws_iam_role" "prod_task" {
  name               = "prod-task-role"
  assume_role_policy = "{}"
}
