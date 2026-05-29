resource "aws_ecs_cluster" "stg_app" {
  name = "stg-app-cluster"
}

resource "aws_s3_bucket" "stg_data" {
  bucket = "stg-data-bucket"
}

resource "aws_iam_role" "stg_task" {
  name               = "stg-task-role"
  assume_role_policy = "{}"
}
